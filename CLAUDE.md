# INA228 Multi-Channel Current Monitor

**PRD:** INA228_Monitor_PRD_v1.2.docx — project code INA228-MON-001

## Project summary
Raspberry Pi 4 system reading up to 16 INA228 sensors through 2× TCA9548A I²C MUXes. Logs daily CSVs committed to this repo; GitHub Pages dashboard reads them from `raw.githubusercontent.com`.

## Key constants
- Shunt: **15 mΩ** (`shunt_ohms: 0.015`) — do not change without hardware change
- MUX-A: `0x70` → sensors 1–8; MUX-B: `0x71` → sensors 9–16; INA228: `0x40`
- INA228 CONFIG word: `0xFB34` (AVG=16, VBUSCT=1052 µs, VSHCT=1052 µs, continuous shunt+bus)
- SHUNT_CAL = `int(13107.2e6 × current_lsb × 0.015)` where `current_lsb = max_expected_amps / 2^19`

## File roles
- `config.yaml` — single source of truth for all runtime settings
- `monitor.py` — production loop; runs as systemd service `ina228-monitor`
- `alerter.py` — rolling-average alert engine; imported by monitor.py
- `debug.py` — Click CLI for hardware bring-up; NOT managed by systemd
- `scripts/git_commit_logs.sh` — called by monitor.py on CSV rotation
- `docs/` — GitHub Pages static dashboard (Plotly + PapaParse, no build step)

## Open items (from PRD §9)
- `alert.gpio_pin` not confirmed — keep `null` until BCM pin is assigned
- Git push credentials on Pi not yet configured (SSH key or HTTPS token needed)
- `git.commit_interval_s` — decide daily-only vs hourly based on dashboard freshness needs

## Target platform
Raspberry Pi 4 Model B running Raspberry Pi OS. Python 3.9+. I²C bus 1.

## Testing without hardware
```bash
python3 debug.py config-check   # validate config.yaml schema
python3 debug.py alert-test 1   # fill deque and fire alert pipeline
```

## Dashboard
Set `REPO_OWNER` / `REPO_NAME` in `docs/dashboard.js` (already set to `SuyogTamrakar / power-monitor-apollo-fleet`).
Enable GitHub Pages: Settings → Pages → Source: `main` branch, `/docs` folder.
