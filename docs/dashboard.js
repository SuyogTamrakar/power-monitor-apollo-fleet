// INA228 Dashboard — chart rendering logic
// Update REPO_OWNER and REPO_NAME to match your GitHub repository.
const REPO_OWNER = "SuyogTamrakar";
const REPO_NAME  = "power-monitor-apollo-fleet";
const RAW_BASE   = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;

// ---- State ---------------------------------------------------------------
let allData = [];      // flat array of parsed CSV rows
let alertData = [];    // rows from alerts.csv
let selectedSensors = new Set();
let darkMode = localStorage.getItem("darkMode") === "true";

// ---- Helpers -------------------------------------------------------------
function isoDate(d) { return d.toISOString().slice(0, 10); }

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr  + "T00:00:00Z");
  while (cur <= end) {
    dates.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const text = await res.text();
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
}

// ---- Data loading --------------------------------------------------------
async function loadData() {
  const start = document.getElementById("startDate").value;
  const end   = document.getElementById("endDate").value;
  if (!start || !end) return;

  document.getElementById("status").textContent = "Loading…";
  allData = [];

  const dates = dateRange(start, end);
  const results = await Promise.allSettled(
    dates.map(d => fetchCSV(`${RAW_BASE}/logs/${d}.csv`))
  );
  results.forEach(r => {
    if (r.status === "fulfilled" && r.value) allData.push(...r.value);
  });

  const alertRes = await fetchCSV(`${RAW_BASE}/logs/alerts.csv`);
  alertData = alertRes || [];

  document.getElementById("status").textContent =
    `Loaded ${allData.length} rows across ${dates.length} day(s).`;

  buildSensorList();
  renderCharts();
  renderStats();
  renderAlertTable();
}

// ---- Sensor selector -----------------------------------------------------
function buildSensorList() {
  const ids = [...new Set(allData.map(r => r.sensor_id))].sort((a, b) => +a - +b);
  selectedSensors = new Set(ids);
  const container = document.getElementById("sensorList");
  container.innerHTML = "";
  ids.forEach(id => {
    const label = allData.find(r => r.sensor_id === id)?.label ?? id;
    const cb = document.createElement("label");
    cb.className = "inline-flex items-center gap-1 mr-3 cursor-pointer";
    cb.innerHTML = `<input type="checkbox" checked value="${id}" onchange="toggleSensor('${id}')"> ${id}: ${label}`;
    container.appendChild(cb);
  });
}

function toggleSensor(id) {
  if (selectedSensors.has(id)) selectedSensors.delete(id);
  else selectedSensors.add(id);
  renderCharts();
  renderStats();
}

// ---- Chart rendering -----------------------------------------------------
function sensorTraces(field) {
  const byId = {};
  allData.forEach(r => {
    if (!selectedSensors.has(r.sensor_id)) return;
    if (!byId[r.sensor_id]) byId[r.sensor_id] = { x: [], y: [], name: `${r.sensor_id}: ${r.label}` };
    byId[r.sensor_id].x.push(r.timestamp);
    byId[r.sensor_id].y.push(parseFloat(r[field]));
  });
  return Object.values(byId).map(t => ({ ...t, type: "scatter", mode: "lines" }));
}

function alertShapes() {
  return alertData
    .filter(r => selectedSensors.has(r.sensor_id))
    .map(r => ({
      type: "line", x0: r.timestamp, x1: r.timestamp, y0: 0, y1: 1,
      xref: "x", yref: "paper",
      line: { color: "red", width: 1, dash: "dash" },
    }));
}

function plotLayout(title, yLabel) {
  const bg = darkMode ? "#1e1e1e" : "#ffffff";
  const fg = darkMode ? "#e0e0e0" : "#333333";
  return {
    title, paper_bgcolor: bg, plot_bgcolor: bg,
    font: { color: fg },
    xaxis: { title: "Timestamp" },
    yaxis: { title: yLabel },
    shapes: alertShapes(),
    margin: { l: 60, r: 20, t: 40, b: 60 },
    autosize: true,
  };
}

function renderCharts() {
  Plotly.newPlot("chartCurrent", sensorTraces("current_mA"), plotLayout("Current over Time", "mA"), { responsive: true });
  Plotly.newPlot("chartVoltage", sensorTraces("voltage_V"),  plotLayout("Voltage over Time", "V"),  { responsive: true });
}

// ---- Stats panel ---------------------------------------------------------
function renderStats() {
  const panel = document.getElementById("statsPanel");
  panel.innerHTML = "";
  const ids = [...selectedSensors];
  ids.forEach(id => {
    const rows = allData.filter(r => r.sensor_id === id && r.valid === "1");
    if (!rows.length) return;
    const currents = rows.map(r => parseFloat(r.current_mA)).filter(v => !isNaN(v));
    const voltages = rows.map(r => parseFloat(r.voltage_V)).filter(v => !isNaN(v));
    const label = rows[0].label;
    const card = document.createElement("div");
    card.className = "p-3 border rounded";
    card.innerHTML = `
      <div class="font-semibold">${id}: ${label}</div>
      <div>Current — min: ${Math.min(...currents).toFixed(1)} mA,
        max: ${Math.max(...currents).toFixed(1)} mA,
        mean: ${(currents.reduce((a,b)=>a+b,0)/currents.length).toFixed(1)} mA</div>
      <div>Voltage — min: ${Math.min(...voltages).toFixed(4)} V,
        max: ${Math.max(...voltages).toFixed(4)} V,
        mean: ${(voltages.reduce((a,b)=>a+b,0)/voltages.length).toFixed(4)} V</div>
    `;
    panel.appendChild(card);
  });
}

// ---- Alert table ---------------------------------------------------------
function renderAlertTable() {
  const tbody = document.getElementById("alertTableBody");
  tbody.innerHTML = "";
  alertData.slice().reverse().forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.timestamp}</td><td>${r.sensor_id}</td><td>${r.label}</td>
      <td>${r.rolling_avg_mA}</td><td>${r.current_mA}</td><td>${r.voltage_V}</td>
      <td>${r.cleared_at || "—"}</td>`;
    tbody.appendChild(tr);
  });
}

// ---- Dark mode toggle ----------------------------------------------------
function toggleDark() {
  darkMode = !darkMode;
  localStorage.setItem("darkMode", darkMode);
  document.body.classList.toggle("dark", darkMode);
  renderCharts();
}

// ---- CSV download --------------------------------------------------------
function downloadCSV() {
  const filtered = allData.filter(r => selectedSensors.has(r.sensor_id));
  const csv = Papa.unparse(filtered);
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ina228-export.csv";
  a.click();
}

// ---- Init ----------------------------------------------------------------
(function init() {
  const today = isoDate(new Date());
  const weekAgo = isoDate(new Date(Date.now() - 7 * 86400 * 1000));
  document.getElementById("startDate").value = weekAgo;
  document.getElementById("endDate").value   = today;
  if (darkMode) document.body.classList.add("dark");
})();
