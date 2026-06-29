"""Quick status check for the INA228 monitor — run in a second terminal."""

import csv
import os
import time
from datetime import datetime, timezone

import yaml

CONFIG_PATH = "config.yaml"
REFRESH_S   = 5   # how often to refresh the display


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def latest_csv(log_dir):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return os.path.join(log_dir, f"{today}.csv")


def read_last_rows(path, n=10):
    """Return the last N rows from a CSV as a list of dicts."""
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    return rows[-n:]


def read_last_hours(log_dir, hours=5):
    """Return all valid rows from the last N hours across today and yesterday's CSVs."""
    cutoff = datetime.now(timezone.utc).timestamp() - hours * 3600
    rows = []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    from datetime import timedelta
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    for date in [yesterday, today]:
        path = os.path.join(log_dir, f"{date}.csv")
        if not os.path.exists(path):
            continue
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                if row.get("valid") != "1":
                    continue
                try:
                    ts = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
                    if ts.timestamp() >= cutoff:
                        rows.append(row)
                except Exception:
                    continue
    return rows


def format_age(ts_str):
    """Return human-readable age of a timestamp string."""
    try:
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        age_s = (datetime.now(timezone.utc) - ts).total_seconds()
        if age_s < 60:
            return f"{int(age_s)}s ago"
        elif age_s < 3600:
            return f"{int(age_s/60)}m ago"
        else:
            return f"{age_s/3600:.1f}h ago"
    except Exception:
        return "?"


def clear():
    os.system("clear")


def run():
    while True:
        try:
            cfg        = load_config()
            log_dir    = cfg["log_dir"]
            sensors    = [s for s in cfg["sensors"] if s.get("enabled")]
            csv_path   = latest_csv(log_dir)
            last_rows  = read_last_rows(csv_path, n=len(sensors) * 2)
            recent_rows = read_last_hours(log_dir, hours=5)
            alerts_csv = os.path.join(log_dir, "alerts.csv")

            # Latest reading per sensor
            latest: dict[str, dict] = {}
            for row in last_rows:
                latest[row["sensor_id"]] = row

            clear()
            now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            print("=" * 64)
            print(f"  INA228 Monitor — Status Check       {now}")
            print("=" * 64)

            # ── Config summary ──────────────────────────────────────────
            print(f"\n  Config")
            print(f"    Sensors enabled   : {len(sensors)}")
            print(f"    Sub-sample rate   : {cfg.get('sub_sample_ms', 5)} ms")
            print(f"    Avg window        : {cfg.get('avg_window_samples', 150)} samples")
            print(f"    Write interval    : {cfg['sampling_interval_s']} s")
            print(f"    Git push interval : {cfg['git'].get('commit_interval_s', 0)} s")

            # ── CSV file ────────────────────────────────────────────────
            print(f"\n  CSV File")
            if os.path.exists(csv_path):
                size_kb = os.path.getsize(csv_path) / 1024
                with open(csv_path) as f:
                    row_count = sum(1 for _ in f) - 1  # minus header
                print(f"    Path     : {csv_path}")
                print(f"    Rows     : {row_count:,}")
                print(f"    Size     : {size_kb:.1f} KB")
            else:
                print(f"    [NOT FOUND] {csv_path}")

            # ── Sensor readings ─────────────────────────────────────────
            print(f"\n  Latest Readings")
            print(f"    {'ID':<4}  {'Label':<12}  {'Voltage':>10}  {'Current':>12}  {'Valid':>5}  {'Age':>8}")
            print(f"    {'-'*4}  {'-'*12}  {'-'*10}  {'-'*12}  {'-'*5}  {'-'*8}")
            for s in sorted(sensors, key=lambda x: x["id"]):
                sid  = str(s["id"])
                row  = latest.get(sid)
                if row:
                    v     = row.get("voltage_V", "?")
                    i     = row.get("current_uA", "?")
                    valid = "OK" if row.get("valid") == "1" else "ERR"
                    age   = format_age(row.get("timestamp", ""))
                    print(f"    {sid:<4}  {s['label']:<12}  {v:>10}V  {i:>10} µA  {valid:>5}  {age:>8}")
                else:
                    print(f"    {sid:<4}  {s['label']:<12}  {'no data yet':>32}")

            # ── 5-hour averages ─────────────────────────────────────────
            print(f"\n  Last 5-Hour Averages")
            print(f"    {'ID':<4}  {'Label':<12}  {'Avg Current':>12}  {'Min':>10}  {'Max':>10}  {'Samples':>8}")
            print(f"    {'-'*4}  {'-'*12}  {'-'*12}  {'-'*10}  {'-'*10}  {'-'*8}")
            by_sensor: dict[str, list] = {}
            for row in recent_rows:
                by_sensor.setdefault(row["sensor_id"], []).append(float(row["current_uA"]))
            for s in sorted(sensors, key=lambda x: x["id"]):
                sid = str(s["id"])
                vals = by_sensor.get(sid, [])
                if vals:
                    avg = sum(vals) / len(vals)
                    print(f"    {sid:<4}  {s['label']:<12}  {avg:>10.2f} µA  "
                          f"{min(vals):>8.2f} µA  {max(vals):>8.2f} µA  {len(vals):>8,}")
                else:
                    print(f"    {sid:<4}  {s['label']:<12}  {'no data':>12}")

            # ── Alerts ──────────────────────────────────────────────────
            print(f"\n  Alerts")
            if os.path.exists(alerts_csv):
                with open(alerts_csv, newline="") as f:
                    alert_rows = list(csv.DictReader(f))
                active = [r for r in alert_rows if not r.get("cleared_at")]
                print(f"    Total alerts (all time) : {len(alert_rows)}")
                print(f"    Currently active        : {len(active)}")
                if active:
                    for r in active[-3:]:
                        print(f"      ⚠  Sensor {r['sensor_id']} ({r['label']}) — "
                              f"{r['rolling_avg_uA']} µA avg since {r['timestamp']}")
            else:
                print("    No alerts logged yet.")

            # ── Git ─────────────────────────────────────────────────────
            print(f"\n  Git")
            result = os.popen("git log --oneline -3 2>/dev/null").read().strip()
            for line in result.splitlines():
                print(f"    {line}")

            print(f"\n  Refreshing every {REFRESH_S}s — Ctrl-C to quit")
            print("=" * 64)

        except FileNotFoundError:
            print("config.yaml not found — run from the project directory.")
        except Exception as exc:
            print(f"Error: {exc}")

        time.sleep(REFRESH_S)


if __name__ == "__main__":
    run()
