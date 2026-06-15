# INA228 Multi-Channel Current Monitor

Raspberry Pi 4 system that reads up to 16 INA228 current/power sensors through two TCA9548A I²C multiplexers. Measurements are logged to daily CSV files committed to this repository. A GitHub Pages dashboard reads those CSVs directly from `raw.githubusercontent.com` — no backend, no API keys.

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

**Live read of sensor 1:**
```bash
python3 debug.py sensor 1
```

**Run production monitor:**
```bash
python3 monitor.py
```

---

## systemd Auto-Start

```bash
sudo cp ina228-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ina228-monitor
sudo systemctl start ina228-monitor
sudo systemctl status ina228-monitor
# Follow logs:
journalctl -u ina228-monitor -f
```

---

## GitHub Pages Dashboard

1. Push repo to GitHub (public, or private with Pages enabled).
2. **Settings → Pages → Source:** `main` branch, `/docs` folder → Save.
3. Dashboard live at `https://SuyogTamrakar.github.io/power-monitor-apollo-fleet` within ~60 s.
4. `REPO_OWNER` / `REPO_NAME` in `docs/dashboard.js` are already set correctly.

The Pi commits `logs/` on each daily CSV rotation (or on the `git.commit_interval_s` schedule). The dashboard fetches whatever CSVs exist at page load time.

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
| `debug.py` | Interactive hardware validation CLI |
| `requirements.txt` | Python dependencies |
| `ina228-monitor.service` | systemd unit |
| `scripts/git_commit_logs.sh` | Commit + push `logs/` |
| `logs/YYYY-MM-DD.csv` | Daily measurement files |
| `logs/alerts.csv` | Append-only alert history |
| `logs/ALERTS.md` | Human-readable alert summary |
| `docs/index.html` | GitHub Pages dashboard |
| `docs/dashboard.js` | Plotly/PapaParse chart logic |

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
