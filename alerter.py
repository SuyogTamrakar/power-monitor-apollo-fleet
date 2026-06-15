"""Rolling-average alert module for INA228 monitor."""

import csv
import logging
import os
from collections import deque, defaultdict
from datetime import datetime, timezone

log = logging.getLogger(__name__)


class Alerter:
    def __init__(self, cfg: dict, log_dir: str):
        self.cfg = cfg["alert"]
        self.sampling_interval_s = cfg["sampling_interval_s"]
        self.log_dir = log_dir
        self.alerts_csv = os.path.join(log_dir, "alerts.csv")
        self.alerts_md = os.path.join(log_dir, "ALERTS.md")

        window_size = int(
            self.cfg["window_hours"] * 3600 / self.sampling_interval_s
        )
        self.deques: dict[int, deque] = defaultdict(lambda: deque(maxlen=window_size))
        self.alert_counts: dict[int, int] = defaultdict(int)
        self.last_alert_ts: dict[int, datetime | None] = defaultdict(lambda: None)
        self.alert_active: dict[int, bool] = defaultdict(bool)

        self._gpio_pin = self.cfg.get("gpio_pin")
        self._gpio = None
        if self._gpio_pin is not None:
            self._init_gpio()

        self._load_existing_alerts()

    # ------------------------------------------------------------------
    def _init_gpio(self):
        try:
            import RPi.GPIO as GPIO  # type: ignore
            GPIO.setmode(GPIO.BCM)
            GPIO.setup(self._gpio_pin, GPIO.OUT, initial=GPIO.LOW)
            self._gpio = GPIO
            log.info("GPIO pin %d initialised for alert output", self._gpio_pin)
        except Exception as exc:
            log.warning("GPIO init failed (non-Pi host?): %s", exc)
            self._gpio_pin = None

    def _set_gpio(self, high: bool):
        if self._gpio is not None:
            import RPi.GPIO as GPIO  # type: ignore
            self._gpio.output(self._gpio_pin, GPIO.HIGH if high else GPIO.LOW)

    # ------------------------------------------------------------------
    def _load_existing_alerts(self):
        if not os.path.exists(self.alerts_csv):
            return
        try:
            with open(self.alerts_csv, newline="") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    sid = int(row["sensor_id"])
                    self.alert_counts[sid] = max(
                        self.alert_counts[sid], int(row.get("alert_count", 0))
                    )
        except Exception as exc:
            log.warning("Could not restore alert history: %s", exc)

    # ------------------------------------------------------------------
    def push(self, sensor_id: int, current_ma: float):
        """Push a new reading into the rolling deque."""
        if current_ma == current_ma:  # skip NaN
            self.deques[sensor_id].append(current_ma)

    def rolling_avg(self, sensor_id: int) -> float | None:
        d = self.deques[sensor_id]
        if not d:
            return None
        return sum(d) / len(d)

    # ------------------------------------------------------------------
    def evaluate(self, readings: list[dict]) -> bool:
        """Evaluate all sensors; return True if any alert is active."""
        if not self.cfg["enabled"]:
            return False

        now = datetime.now(timezone.utc)
        threshold = self.cfg["threshold_ma"]
        cooldown_s = self.cfg["cooldown_minutes"] * 60
        any_active = False

        for r in readings:
            sid = r["sensor_id"]
            avg = self.rolling_avg(sid)
            if avg is None:
                continue

            if avg > threshold:
                last = self.last_alert_ts[sid]
                in_cooldown = (
                    last is not None
                    and (now - last).total_seconds() < cooldown_s
                )
                if not in_cooldown:
                    self.alert_counts[sid] += 1
                    self.last_alert_ts[sid] = now
                    self._write_alert_row(r, avg, now)
                self.alert_active[sid] = True
                any_active = True
            else:
                if self.alert_active[sid]:
                    self._write_cleared(sid, now)
                self.alert_active[sid] = False

        self._regen_alerts_md(readings, now)
        self._set_gpio(any_active)
        return any_active

    # ------------------------------------------------------------------
    def _write_alert_row(self, r: dict, avg: float, now: datetime):
        sid = r["sensor_id"]
        new_file = not os.path.exists(self.alerts_csv)
        with open(self.alerts_csv, "a", newline="") as f:
            fieldnames = [
                "timestamp", "sensor_id", "label",
                "rolling_avg_mA", "current_mA", "voltage_V",
                "alert_count", "cleared_at",
            ]
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            if new_file:
                writer.writeheader()
            writer.writerow({
                "timestamp": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "sensor_id": sid,
                "label": r["label"],
                "rolling_avg_mA": round(avg, 2),
                "current_mA": r["current_mA"],
                "voltage_V": r["voltage_V"],
                "alert_count": self.alert_counts[sid],
                "cleared_at": "",
            })
        log.warning(
            "ALERT sensor %d (%s): rolling avg %.2f mA > %.1f mA threshold",
            sid, r["label"], avg, self.cfg["threshold_ma"],
        )

    def _write_cleared(self, sensor_id: int, now: datetime):
        # Mark the most recent open alert row for this sensor as cleared
        if not os.path.exists(self.alerts_csv):
            return
        rows = []
        updated = False
        with open(self.alerts_csv, newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            for row in reader:
                if (
                    int(row["sensor_id"]) == sensor_id
                    and not row["cleared_at"]
                    and not updated
                ):
                    row["cleared_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
                    updated = True
                rows.append(row)
        if updated and fieldnames:
            with open(self.alerts_csv, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)

    # ------------------------------------------------------------------
    def _regen_alerts_md(self, readings: list[dict], now: datetime):
        if not os.path.exists(self.alerts_csv):
            return

        all_rows: list[dict] = []
        with open(self.alerts_csv, newline="") as f:
            all_rows = list(csv.DictReader(f))

        total_alerts = len(all_rows)

        # Per-sensor summary
        sensor_summary: dict[int, dict] = {}
        for row in all_rows:
            sid = int(row["sensor_id"])
            sensor_summary[sid] = {
                "label": row["label"],
                "count": int(row["alert_count"]),
                "last_ts": row["timestamp"],
                "last_avg": row["rolling_avg_mA"],
                "status": "ACTIVE" if not row["cleared_at"] else "CLEARED",
            }

        recent = list(reversed(all_rows[-50:]))

        lines = [
            "# INA228 Alert Log",
            f"Last updated: {now.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            f"Total alerts (all sensors, all time): {total_alerts}",
            f"Threshold: {self.cfg['threshold_ma']} mA  |  "
            f"Window: {self.cfg['window_hours']} h  |  "
            f"Cooldown: {self.cfg['cooldown_minutes']} min",
            "",
            "## Sensor Summary",
            "| ID | Label | Alerts | Last Alert | Avg mA | Status |",
            "|----|-------|--------|------------|--------|--------|",
        ]
        for sid, s in sorted(sensor_summary.items()):
            lines.append(
                f"| {sid:2d} | {s['label']:<8} | {s['count']:6d} | "
                f"{s['last_ts']} | {s['last_avg']:>6} | {s['status']} |"
            )

        lines += [
            "",
            "## Recent Alerts (last 50)",
            "| Timestamp | ID | Label | Avg mA | Current mA | Voltage V | Cleared At |",
            "|-----------|----|----|--------|-----------|----------|-----------|",
        ]
        for row in recent:
            lines.append(
                f"| {row['timestamp']} | {row['sensor_id']} | {row['label']} | "
                f"{row['rolling_avg_mA']} | {row['current_mA']} | "
                f"{row['voltage_V']} | {row.get('cleared_at', '')} |"
            )

        with open(self.alerts_md, "w") as f:
            f.write("\n".join(lines) + "\n")
