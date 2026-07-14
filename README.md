# INA228 Multi-Channel Current Monitor

Raspberry Pi 4 system that reads up to 16 INA228 current/power sensors through two TCA9548A I²C multiplexers. Measurements are logged to daily CSV files committed to this repository every 5 minutes. A GitHub Pages dashboard reads those CSVs directly from `raw.githubusercontent.com` — no backend, no API keys.

**PRD:** `INA228_Monitor_PRD_v1.2.docx` — project code `INA228-MON-001`

---

## Hardware

| Qty | Component | Notes |
|-----|-----------|-------|
| 1 | Raspberry Pi 4 Model B | 4 GB RAM recommended |
| 2 | TCA9548A 8-ch I²C MUX | 0x70 (MUX-A, sensors 1–8), 0x71 (MUX-B, sensors 9–16) |
| up to 16 | INA228 Qwiic/STEMMA QT | All at 0x40; one MUX channel open at a time |
| 16 | 15 mΩ shunt resistors | Vishay WSL2010R0150FEA, 1%, 0.5 W |
| 1 | 5 V / 3 A USB-C PSU | |

I²C bus: GPIO 2/3 (bus 1). Enable with `sudo raspi-config → Interface Options → I²C`.

---

## Resolution & Accuracy

With a 15 mΩ shunt and `max_expected_amps: 2.0`:

| Metric | Value |
|--------|-------|
| Current LSB | ~3.8 µA / bit |
| Voltage LSB | 195.3 µV / bit (fixed) |
| Shunt offset error | ±167 µA worst-case (readings below ~200 µA are unreliable) |
| Gain error | ±0.1% |
| Shunt resistor tolerance | ±1% → ±1% current error |
| Effective noise floor (after 150-sample avg) | ~1–2 µA |

---

## Quick Start

```bash
git clone https://github.com/SuyogTamrakar/power-monitor-apollo-fleet.git
cd power-monitor-apollo-fleet
pip3 install -r requirements.txt
```

Edit `config.yaml` — set enabled sensors, labels, and `alert.gpio_pin`.

**Validate config (no hardware needed):**
```bash
python3 debug.py config-check
```

**Scan I²C bus:**
```bash
python3 debug.py scan
```

**Test all MUX ports:**
```bash
python3 debug.py mux-test
```

**Live read of a single sensor:**
```bash
python3 debug.py sensor 1
python3 debug.py sensor 8 --avg-window 200   # custom rolling average window
```

**Run production monitor manually:**
```bash
python3 monitor.py
```

**Live status check (run in a second terminal):**
```bash
python3 status.py
```
Shows latest readings per sensor, 5-hour averages (min/max/avg/samples), active alerts, and recent git commits.

---

## systemd Auto-Start

The monitor runs as a systemd service and restarts automatically on reboot or crash.

```bash
sudo cp ina228-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ina228-monitor
sudo systemctl start ina228-monitor
sudo systemctl status ina228-monitor

# Follow live logs
journalctl -u ina228-monitor -f
```

After a reboot, the service starts automatically — no manual intervention needed.

---

## Data Pipeline

```
INA228 sensors
    │  I²C (5 ms sub-sample)
    ▼
monitor.py  ──► logs/YYYY-MM-DD.csv  (one averaged row per sensor every 5 s)
    │                                 (8 sensors × 5 s = ~138 k rows/day)
    ▼ every 5 min
scripts/git_commit_logs.sh
    │  git add logs/ → commit → fetch → merge -X ours → push
    ▼
GitHub (main branch)
    ▼  raw.githubusercontent.com CDN (~5 min cache)
GitHub Pages dashboard
```

**Key implementation detail:** `monitor.py` closes and reopens the CSV file after every git commit. This prevents a subtle bug where `git merge` replaces the file's inode on disk while the Python process holds a stale file handle — which would cause all subsequent writes to go to an untracked ghost file.

---

## Git Strategy

`scripts/git_commit_logs.sh` uses `git merge -X ours` (not rebase) to integrate remote changes. This means:
- The Pi's local CSV always wins on conflict (it has the newest data).
- Code changes pushed from other machines are absorbed cleanly.
- No interactive conflict resolution is ever needed.

---

## GitHub Pages Dashboard

1. Push repo to GitHub (public, or private with Pages enabled).
2. **Settings → Pages → Source:** `main` branch, `/docs` folder → Save.
3. Dashboard live at `https://SuyogTamrakar.github.io/power-monitor-apollo-fleet` within ~60 s.

### Dashboard Features

- **Charts tab** — Plotly time-series charts for current (µA) and voltage (V) across all sensors.
- **Range Statistics tab** — per-sensor table of min, max, avg, and sample count for current and voltage over the selected range.
- **Quick range buttons** — Last 30 min / 1h / 4h / 24h / 7d / 1mo / 3mo / 6mo.
- **Custom date range** — pick any start/end date.
- **Sensor selector** — show/hide individual DUTs.
- **Day-over-day anomaly detection** — flags any sensor drawing ≥2× its yesterday average.
- **Alert events table** — full history from `logs/alerts.csv`.
- **Auto-refresh** — reloads data every 310 seconds (matching the 5-minute push interval).
- **Dark / Light mode** — persisted in localStorage.
- **Download CSV** — exports the currently visible filtered data.
- **Timestamps displayed in local timezone** (PDT/PST/etc.), not UTC.

### Dashboard Data Freshness

Data is fetched from `raw.githubusercontent.com` with `cache: no-store`. The CDN caches for ~5 minutes, so the dashboard may show data up to ~10 minutes behind real-time (5-min push + 5-min CDN lag). This is intentional — using the GitHub Contents API instead would hit the 60 req/hour unauthenticated rate limit within 30 minutes.

### Cache Busting

If the dashboard JS does not update after a push, bump the version query string in `docs/index.html`:
```html
<script src="dashboard.js?v=12"></script>
```

---

## Git Push Authentication on the Pi

```bash
# SSH key (recommended)
ssh-keygen -t ed25519 -C "pi@ina228-monitor"
cat ~/.ssh/id_ed25519.pub   # add to GitHub → Settings → SSH keys

# OR HTTPS token
git remote set-url origin https://<TOKEN>@github.com/SuyogTamrakar/power-monitor-apollo-fleet.git
```

---

## File Map

| Path | Purpose |
|------|---------|
| `config.yaml` | All user settings — sensors, thresholds, git options |
| `monitor.py` | Production sampling loop (run via systemd) |
| `alerter.py` | Rolling-average alert engine |
| `status.py` | Live terminal status dashboard (latest readings + 5-hr averages) |
| `debug.py` | Interactive hardware validation CLI |
| `requirements.txt` | Python dependencies |
| `ina228-monitor.service` | systemd unit (auto-restarts on failure) |
| `scripts/git_commit_logs.sh` | Commit + push `logs/` every 5 min |
| `logs/YYYY-MM-DD.csv` | Daily measurement files |
| `logs/alerts.csv` | Append-only alert history |
| `logs/ALERTS.md` | Human-readable alert summary |
| `docs/index.html` | GitHub Pages dashboard (v12) |
| `docs/dashboard.js` | Plotly/PapaParse chart + stats logic |

---

## Sampling Configuration

| Parameter | Value | Notes |
|-----------|-------|-------|
| `sub_sample_ms` | 5 ms | Raw I²C read interval (practical floor at 100 kHz with 1 sensor) |
| `avg_window_samples` | 150 | Rolling average = 150 × 5 ms = 750 ms smoothing |
| `sampling_interval_s` | 5 s | One CSV row written per sensor per interval |
| `commit_interval_s` | 300 s | Git push cadence |

---

## Acceptance Criteria (from PRD v1.2)

| ID | Test | Pass Condition |
|----|------|----------------|
| AC-01 | `debug.py sensor 1` | V in 4.0–7.2 V; I within ±5% of DMM |
| AC-02 | 16-sensor full scan | All 16 CSV rows written within 8 s |
| AC-03 | Dashboard loads | Charts render within 10 s |
| AC-05 | Sensor dropout | `valid=0` row; no crash |
| AC-06 | Boot auto-start | Service active within 60 s of power-on |
| AC-09 | Alert fires | Row in `alerts.csv` after >5 mA / 2 h |
| AC-12 | Daily rotation | New CSV at midnight + git push |
