// INA228 Dashboard
const REPO_OWNER = "SuyogTamrakar";
const REPO_NAME  = "power-monitor-apollo-fleet";
const RAW_BASE   = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;

// ---- State ---------------------------------------------------------------
let allData       = [];   // flat array of all loaded CSV rows (full days)
let alertData     = [];
let selectedSensors = new Set();
let darkMode      = localStorage.getItem("darkMode") === "true";
let activeRangeMs = null; // null = custom date range

// ---- Helpers -------------------------------------------------------------
function isoDate(d)  { return d.toISOString().slice(0, 10); }
function nowMs()     { return Date.now(); }

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr  + "T00:00:00Z");
  while (cur <= end) { dates.push(isoDate(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return dates;
}

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const text = await res.text();
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
}

// ---- Range buttons -------------------------------------------------------
function setRange(ms, btn) {
  activeRangeMs = ms;
  document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");

  const end   = new Date();
  const start = new Date(end.getTime() - ms);
  document.getElementById("startDate").value = isoDate(start);
  document.getElementById("endDate").value   = isoDate(end);
  loadData();
}

function clearActiveRange() {
  activeRangeMs = null;
  document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
}

// Filter rows to the active range window (for sub-day ranges)
function filterByRange(rows) {
  if (!activeRangeMs) return rows;
  const cutoff = new Date(nowMs() - activeRangeMs);
  return rows.filter(r => new Date(r.timestamp) >= cutoff);
}

// ---- Data loading --------------------------------------------------------
async function loadData() {
  const start = document.getElementById("startDate").value;
  const end   = document.getElementById("endDate").value;
  if (!start || !end) return;

  document.getElementById("status").textContent = "Loading…";
  allData = [];

  const dates   = dateRange(start, end);
  const results = await Promise.allSettled(
    dates.map(d => fetchCSV(`${RAW_BASE}/logs/${d}.csv`))
  );
  results.forEach(r => { if (r.status === "fulfilled" && r.value) allData.push(...r.value); });

  const alertRes = await fetchCSV(`${RAW_BASE}/logs/alerts.csv`);
  alertData = alertRes || [];

  const visible = filterByRange(allData);
  document.getElementById("status").textContent =
    `Loaded ${visible.length} rows across ${dates.length} day(s).`;
  document.getElementById("lastRefresh").textContent =
    `Last updated: ${new Date().toLocaleTimeString()}`;

  buildSensorList(visible);
  renderCharts(visible);
  renderStats(visible);
  renderAlertTable(visible);
}

// ---- Sensor selector -----------------------------------------------------
function buildSensorList(rows) {
  const ids = [...new Set(rows.map(r => r.sensor_id))].sort((a,b) => +a - +b);
  if (selectedSensors.size === 0) selectedSensors = new Set(ids);
  const container = document.getElementById("sensorList");
  container.innerHTML = "";
  ids.forEach(id => {
    const label = rows.find(r => r.sensor_id === id)?.label ?? id;
    const checked = selectedSensors.has(id) ? "checked" : "";
    const el = document.createElement("label");
    el.className = "inline-flex items-center gap-1 px-2 py-1 border rounded text-sm cursor-pointer";
    el.innerHTML = `<input type="checkbox" ${checked} value="${id}" onchange="toggleSensor('${id}')"> ${id}: ${label}`;
    container.appendChild(el);
  });
}

function toggleSensor(id) {
  if (selectedSensors.has(id)) selectedSensors.delete(id);
  else selectedSensors.add(id);
  const visible = filterByRange(allData);
  renderCharts(visible);
  renderStats(visible);
}

function selectAllSensors(on) {
  document.querySelectorAll("#sensorList input[type=checkbox]").forEach(cb => {
    cb.checked = on;
    if (on) selectedSensors.add(cb.value);
    else selectedSensors.delete(cb.value);
  });
  const visible = filterByRange(allData);
  renderCharts(visible);
  renderStats(visible);
}

// ---- Chart rendering -----------------------------------------------------
function sensorTraces(rows, field) {
  const byId = {};
  rows.forEach(r => {
    if (!selectedSensors.has(r.sensor_id)) return;
    if (!byId[r.sensor_id]) byId[r.sensor_id] = { x: [], y: [], name: `${r.sensor_id}: ${r.label}`, mode: "lines", type: "scatter" };
    byId[r.sensor_id].x.push(r.timestamp);
    byId[r.sensor_id].y.push(parseFloat(r[field]));
  });
  return Object.values(byId);
}

function alertShapes(rows) {
  const ts = new Set(rows.map(r => r.timestamp));
  return alertData
    .filter(r => selectedSensors.has(r.sensor_id) && ts.has(r.timestamp))
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
    xaxis: { title: "Timestamp", type: "date" },
    yaxis: { title: yLabel },
    legend: { orientation: "h", y: -0.2 },
    margin: { l: 60, r: 20, t: 40, b: 80 },
    autosize: true,
  };
}

function renderCharts(rows) {
  Plotly.react("chartCurrent", sensorTraces(rows, "current_uA"), plotLayout("Current (µA)", "µA"),  { responsive: true });
  Plotly.react("chartVoltage",  sensorTraces(rows, "voltage_V"),  plotLayout("Voltage (V)", "V"),    { responsive: true });
}

// ---- Stats panel ---------------------------------------------------------
function renderStats(rows) {
  const panel = document.getElementById("statsPanel");
  panel.innerHTML = "";
  [...selectedSensors].sort().forEach(id => {
    const sRows = rows.filter(r => r.sensor_id === id && r.valid === "1");
    if (!sRows.length) return;
    const currents = sRows.map(r => parseFloat(r.current_uA)).filter(v => !isNaN(v));
    const voltages = sRows.map(r => parseFloat(r.voltage_V)).filter(v => !isNaN(v));
    const label = sRows[0].label;
    const card = document.createElement("div");
    card.className = "p-3 border rounded text-sm";
    card.innerHTML = `
      <div class="font-semibold mb-1">${id}: ${label}</div>
      <div>Current</div>
      <div class="pl-2 text-xs">
        Min: ${Math.min(...currents).toFixed(2)} µA<br>
        Max: ${Math.max(...currents).toFixed(2)} µA<br>
        Avg: ${(currents.reduce((a,b)=>a+b,0)/currents.length).toFixed(2)} µA
      </div>
      <div class="mt-1">Voltage</div>
      <div class="pl-2 text-xs">
        Min: ${Math.min(...voltages).toFixed(4)} V<br>
        Max: ${Math.max(...voltages).toFixed(4)} V<br>
        Avg: ${(voltages.reduce((a,b)=>a+b,0)/voltages.length).toFixed(4)} V
      </div>
      <div class="text-xs text-gray-400 mt-1">${sRows.length} samples</div>
    `;
    panel.appendChild(card);
  });
}

// ---- Alert table ---------------------------------------------------------
function renderAlertTable(rows) {
  const ts = new Set(rows.map(r => r.timestamp));
  const tbody = document.getElementById("alertTableBody");
  tbody.innerHTML = "";
  alertData.slice().reverse().forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.timestamp}</td><td>${r.sensor_id}</td><td>${r.label}</td>
      <td>${r.rolling_avg_uA}</td><td>${r.current_uA}</td><td>${r.voltage_V}</td>
      <td>${r.cleared_at || "—"}</td>`;
    tbody.appendChild(tr);
  });
}

// ---- Dark mode -----------------------------------------------------------
function toggleDark() {
  darkMode = !darkMode;
  localStorage.setItem("darkMode", darkMode);
  document.body.classList.toggle("dark", darkMode);
  const visible = filterByRange(allData);
  renderCharts(visible);
}

// ---- CSV download --------------------------------------------------------
function downloadCSV() {
  const visible = filterByRange(allData).filter(r => selectedSensors.has(r.sensor_id));
  const csv = Papa.unparse(visible);
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ina228-export.csv";
  a.click();
}

// ---- Auto-refresh --------------------------------------------------------
let autoRefreshTimer = null;
const AUTO_REFRESH_MS = 60 * 1000; // refresh data every 60 seconds

function scheduleRefresh() {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(async () => {
    // Update date inputs if a quick range is active so the window slides forward
    if (activeRangeMs) {
      const end   = new Date();
      const start = new Date(end.getTime() - activeRangeMs);
      document.getElementById("startDate").value = isoDate(start);
      document.getElementById("endDate").value   = isoDate(end);
    }
    await loadData();
    scheduleRefresh();
  }, AUTO_REFRESH_MS);
}

// ---- Init ----------------------------------------------------------------
(function init() {
  if (darkMode) document.body.classList.add("dark");
  // Default to last 1 hour on load
  const end   = new Date();
  const start = new Date(end.getTime() - 60*60*1000);
  document.getElementById("startDate").value = isoDate(start);
  document.getElementById("endDate").value   = isoDate(end);
  activeRangeMs = 60*60*1000;
  window.addEventListener("load", () => {
    const btns = document.querySelectorAll(".range-btn");
    if (btns[1]) btns[1].classList.add("active");
    loadData().then(scheduleRefresh);
  });
})();
