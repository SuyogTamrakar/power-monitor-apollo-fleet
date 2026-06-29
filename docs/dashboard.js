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

// Convert a UTC ISO string to a local-time ISO string (no Z suffix) for Plotly display.
// Plotly treats date strings without Z as-is, so this shifts the axis to local time.
function toLocalISO(utcStr) {
  const d = new Date(utcStr);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

// Short timezone label for axis titles, e.g. "PDT" or "PST"
const TZ_LABEL = new Date().toLocaleTimeString("en-us", { timeZoneName: "short" }).split(" ").pop();

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr  + "T00:00:00Z");
  while (cur <= end) { dates.push(isoDate(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return dates;
}

async function fetchCSV(url) {
  // Append timestamp to bust GitHub's raw CDN cache
  const bustUrl = `${url}?t=${Math.floor(Date.now() / 60000)}`; // changes every minute
  const res = await fetch(bustUrl, { cache: "no-store" });
  if (!res.ok) return null;
  const text = await res.text();
  // Stream-parse line by line to avoid stack overflow on huge files,
  // then immediately bucket into hourly/minute averages before returning.
  // This keeps memory flat regardless of file size.
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim());
  const tsIdx  = header.indexOf('timestamp');
  const sidIdx = header.indexOf('sensor_id');
  const labIdx = header.indexOf('label');
  const vIdx   = header.indexOf('voltage_V');
  const iIdx   = header.indexOf('current_uA');
  const valIdx = header.indexOf('valid');
  if (tsIdx < 0 || iIdx < 0) return [];

  // Pre-bucket as we parse — avoids holding all rows in memory
  const bSize  = bucketSizeMs();
  const buckets = {};  // key → {timestamp, sensor_id, label, vSum, iSum, count, valid}

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    const cols = line.split(',');
    const ts   = cols[tsIdx];
    const sid  = cols[sidIdx];
    const iVal = parseFloat(cols[iIdx]);
    const vVal = parseFloat(cols[vIdx]);
    if (!ts || !sid || isNaN(iVal)) continue;
    const t      = new Date(ts).getTime();
    const bucket = Math.floor(t / bSize) * bSize;
    const key    = `${sid}__${bucket}`;
    if (!buckets[key]) {
      buckets[key] = {
        timestamp: new Date(bucket).toISOString(),
        sensor_id: sid,
        label:     cols[labIdx] || sid,
        voltage_V: 0, current_uA: 0, count: 0, valid: '1',
      };
    }
    buckets[key].voltage_V  += isNaN(vVal) ? 0 : vVal;
    buckets[key].current_uA += iVal;
    buckets[key].count      += 1;
    if (cols[valIdx] === '0') buckets[key].valid = '0';
  }

  return Object.values(buckets).map(b => ({
    timestamp:  b.timestamp,
    sensor_id:  b.sensor_id,
    label:      b.label,
    voltage_V:  (b.voltage_V  / b.count).toFixed(4),
    current_uA: (b.current_uA / b.count).toFixed(2),
    valid:      b.valid,
  }));
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

  try {
    // For sub-day quick ranges, only fetch the CSVs we actually need.
    let dates = dateRange(start, end);
    if (activeRangeMs && activeRangeMs < 24*60*60*1000) {
      const now = new Date();
      const cutoff = new Date(now.getTime() - activeRangeMs);
      dates = [...new Set([isoDate(cutoff), isoDate(now)])];
    }

    const results = await Promise.allSettled(
      dates.map(d => fetchCSV(`${RAW_BASE}/logs/${d}.csv`))
    );
    results.forEach(r => { if (r.status === "fulfilled" && r.value) allData = allData.concat(r.value); });

    // Fetch yesterday separately for anomaly detection (don't let it block or pollute main data)
    const todayStr     = isoDate(new Date());
    const yesterdayStr = isoDate(new Date(Date.now() - 86400000));
    const anomalyDates = [yesterdayStr, todayStr].filter(d => !dates.includes(d));
    let anomalyRows = [];
    for (const d of anomalyDates) {
      const r = await fetchCSV(`${RAW_BASE}/logs/${d}.csv`);
      if (r) anomalyRows = anomalyRows.concat(r);
    }

    const alertRes = await fetchCSV(`${RAW_BASE}/logs/alerts.csv`);
    alertData = alertRes || [];

    const visible = filterByRange(allData);
    document.getElementById("status").textContent =
      `${visible.length} rows loaded`;
    document.getElementById("lastRefresh").textContent =
      `Last updated: ${new Date().toLocaleTimeString()}`;

    buildSensorList(visible);
    renderCharts(visible);
    renderStats(visible);
    renderAlertTable(visible);
    renderAnomalyAlerts(allData.concat(anomalyRows)); // needs today + yesterday
  } catch (err) {
    document.getElementById("status").textContent = `Error: ${err.message}`;
  }
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
// Bucket size in ms based on selected range — keeps chart readable
function bucketSizeMs() {
  if (!activeRangeMs)               return 60 * 1000;         // custom: 1 min buckets
  if (activeRangeMs <= 30*60*1000)  return 5  * 1000;         // 30 min: 5s buckets (raw-ish)
  if (activeRangeMs <= 60*60*1000)  return 15 * 1000;         // 1 hour: 15s buckets
  if (activeRangeMs <= 4*60*60*1000) return 60 * 1000;        // 4 hours: 1 min buckets
  if (activeRangeMs <= 24*60*60*1000) return 5 * 60 * 1000;   // 24 hours: 5 min buckets
  if (activeRangeMs <= 7*24*60*60*1000) return 60*60*1000;    // 7 days: 1 hour buckets
  if (activeRangeMs <= 90*24*60*60*1000)  return 60*60*1000;   // 3 months: 1 hour buckets
  return 4 * 60 * 60 * 1000;                                   // 6 months: 4 hour buckets
}

function timeBucket(rows, field) {
  const bSize = bucketSizeMs();
  const byId  = {};

  rows.forEach(r => {
    if (!selectedSensors.has(r.sensor_id)) return;
    const val = parseFloat(r[field]);
    if (isNaN(val)) return;
    const ts     = new Date(r.timestamp).getTime();
    const bucket = Math.floor(ts / bSize) * bSize;
    const key    = `${r.sensor_id}__${bucket}`;
    if (!byId[key]) byId[key] = { sid: r.sensor_id, label: r.label, bucket, sum: 0, count: 0 };
    byId[key].sum   += val;
    byId[key].count += 1;
  });

  // Group buckets by sensor
  const bySensor = {};
  Object.values(byId).forEach(b => {
    if (!bySensor[b.sid]) bySensor[b.sid] = { name: `${b.sid}: ${b.label}`, pts: [] };
    bySensor[b.sid].pts.push({ x: new Date(b.bucket).toISOString(), y: b.sum / b.count });
  });

  return Object.values(bySensor).map(s => {
    s.pts.sort((a, b) => a.x.localeCompare(b.x));
    return { x: s.pts.map(p => p.x), y: s.pts.map(p => p.y), name: s.name, mode: "lines", type: "scatter" };
  });
}

function sensorTraces(rows, field) {
  // Data is already bucketed by fetchCSV — group by sensor, sort, convert to local time for display
  const byId = {};
  rows.forEach(r => {
    if (!selectedSensors.has(r.sensor_id)) return;
    if (!byId[r.sensor_id]) byId[r.sensor_id] = { pts: [], name: `${r.sensor_id}: ${r.label}` };
    byId[r.sensor_id].pts.push({ x: r.timestamp, y: parseFloat(r[field]) });
  });
  return Object.values(byId).map(t => {
    t.pts.sort((a, b) => a.x.localeCompare(b.x));
    return {
      x: t.pts.map(p => toLocalISO(p.x)),
      y: t.pts.map(p => p.y),
      name: t.name, mode: "lines", type: "scatter",
    };
  });
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

function xAxisConfig() {
  // Choose tick format and spacing to match the active range
  const ms = activeRangeMs;
  if (!ms || ms <= 60*60*1000)          // ≤1 h  → HH:MM:SS
    return { tickformat: "%H:%M:%S",   dtick: ms ? ms / 6 : 10*60*1000, title: `Time (${TZ_LABEL})` };
  if (ms <= 4*60*60*1000)               // ≤4 h  → HH:MM
    return { tickformat: "%H:%M",      dtick: 30*60*1000,               title: `Time (${TZ_LABEL})` };
  if (ms <= 24*60*60*1000)              // ≤24 h → HH:MM with date
    return { tickformat: "%b %d  %H:%M", dtick: 2*60*60*1000,          title: `Date / Time (${TZ_LABEL})` };
  if (ms <= 7*24*60*60*1000)            // ≤7 d  → Mon Jun 29
    return { tickformat: "%a %b %d",   dtick: 24*60*60*1000,           title: "Date" };
  if (ms <= 90*24*60*60*1000)           // ≤3 mo → Jun 01
    return { tickformat: "%b %d",      dtick: 7*24*60*60*1000,         title: "Date" };
  return   { tickformat: "%b %Y",      dtick: 30*24*60*60*1000,        title: "Month" };
}

function plotLayout(title, yLabel) {
  const bg  = darkMode ? "#1e1e1e" : "#ffffff";
  const fg  = darkMode ? "#e0e0e0" : "#333333";
  const xax = xAxisConfig();
  return {
    title,
    paper_bgcolor: bg, plot_bgcolor: bg,
    font: { color: fg },
    xaxis: {
      type: "date",
      title: xax.title,
      tickformat: xax.tickformat,
      dtick: xax.dtick,
      tickangle: -35,
      tickfont: { size: 11 },
      gridcolor: darkMode ? "#333" : "#e5e7eb",
      showgrid: true,
    },
    yaxis: {
      title: yLabel,
      gridcolor: darkMode ? "#333" : "#e5e7eb",
      showgrid: true,
    },
    legend: { orientation: "h", y: -0.28 },
    margin: { l: 65, r: 20, t: 40, b: 100 },
    autosize: true,
    hovermode: "x unified",
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

// ---- Day-over-day anomaly detection --------------------------------------
function renderAnomalyAlerts(allRows) {
  const panel = document.getElementById("anomalyPanel");
  if (!panel) return;

  // Split rows into today vs yesterday by UTC date
  const todayStr     = isoDate(new Date());
  const yesterdayStr = isoDate(new Date(Date.now() - 86400000));

  // Compute per-sensor daily averages (valid rows only)
  const avgs = {}; // avgs[sid][date] = { sum, count }
  allRows.forEach(r => {
    if (r.valid !== "1") return;
    const d = r.timestamp.slice(0, 10);
    if (d !== todayStr && d !== yesterdayStr) return;
    const val = parseFloat(r.current_uA);
    if (isNaN(val)) return;
    if (!avgs[r.sensor_id]) avgs[r.sensor_id] = {};
    if (!avgs[r.sensor_id][d]) avgs[r.sensor_id][d] = { sum: 0, count: 0 };
    avgs[r.sensor_id][d].sum   += val;
    avgs[r.sensor_id][d].count += 1;
  });

  const anomalies = [];
  Object.entries(avgs).forEach(([sid, days]) => {
    const tod  = days[todayStr];
    const yest = days[yesterdayStr];
    if (!tod || !yest || yest.count === 0) return;
    const todAvg  = tod.sum  / tod.count;
    const yestAvg = yest.sum / yest.count;
    if (yestAvg < 1) return; // ignore noise-floor sensors (< 1 µA baseline)
    const ratio = todAvg / yestAvg;
    if (ratio >= 2) {
      const label = allRows.find(r => r.sensor_id === sid)?.label ?? sid;
      anomalies.push({ sid, label, todAvg, yestAvg, ratio });
    }
  });

  panel.innerHTML = "";
  if (anomalies.length === 0) {
    panel.innerHTML = `<div class="text-sm text-green-600 px-3 py-2 border border-green-300 rounded bg-green-50">
      All sensors normal — no sensor is drawing 2× or more than yesterday.
    </div>`;
    return;
  }

  anomalies.sort((a, b) => b.ratio - a.ratio).forEach(a => {
    const div = document.createElement("div");
    div.className = "flex items-start gap-3 px-3 py-2 border border-red-300 rounded bg-red-50 text-sm";
    div.innerHTML = `
      <span class="text-red-500 text-lg leading-none">&#9888;</span>
      <div>
        <span class="font-semibold text-red-700">${a.sid}: ${a.label}</span>
        <span class="ml-2 text-red-600">${a.ratio.toFixed(1)}× yesterday</span>
        <div class="text-xs text-red-500 mt-0.5">
          Today avg: ${a.todAvg.toFixed(2)} µA &nbsp;|&nbsp; Yesterday avg: ${a.yestAvg.toFixed(2)} µA
        </div>
      </div>
    `;
    panel.appendChild(div);
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
  activeRangeMs = 30*60*1000;
  window.addEventListener("load", () => {
    const btns = document.querySelectorAll(".range-btn");
    if (btns[0]) btns[0].classList.add("active");
    loadData().then(scheduleRefresh);
  });
})();
