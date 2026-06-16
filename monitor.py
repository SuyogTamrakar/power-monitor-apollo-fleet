"""INA228 Multi-Channel Current Monitor — main production script."""

import csv
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from math import isnan

import yaml

from alerter import Alerter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)

# INA228 register addresses
_REG_CONFIG    = 0x00
_REG_SHUNT_CAL = 0x02
_REG_VBUS      = 0x05
_REG_CURRENT   = 0x07
_REG_DIAG_ALRT = 0x0B

# CONFIG word: AVG=16 (bits[8:6]=011), VBUSCT=1052µs (bits[5:3]=100),
# VSHCT=1052µs (bits[2:0]=100), MODE=Continuous shunt+bus (bits[15:12]=1111)
_CONFIG_VALUE = 0xFB34
_DIAG_CNVRF   = 0x0001


def _load_config(path: str = "config.yaml") -> dict:
    if not os.path.exists(path):
        log.error("config.yaml not found at %s", path)
        sys.exit(1)
    with open(path) as f:
        cfg = yaml.safe_load(f)

    required = ["sampling_interval_s", "shunt_ohms", "max_expected_amps",
                "log_dir", "sensors", "alert", "git"]
    for key in required:
        if key not in cfg:
            log.error("config.yaml missing required key: %s", key)
            sys.exit(1)
    return cfg


def _open_mux_channel(bus, mux_addr: int, channel: int):
    bus.write_byte(mux_addr, 1 << channel)


def _close_mux(bus, mux_addr: int):
    bus.write_byte(mux_addr, 0x00)


def _write_reg16(bus, dev_addr: int, reg: int, value: int):
    high = (value >> 8) & 0xFF
    low = value & 0xFF
    bus.write_i2c_block_data(dev_addr, reg, [high, low])


def _read_reg16_signed(bus, dev_addr: int, reg: int) -> int:
    data = bus.read_i2c_block_data(dev_addr, reg, 3)
    raw = (data[0] << 16) | (data[1] << 8) | data[2]
    raw >>= 4  # INA228 uses 20-bit 2's-complement result in top 20 bits
    if raw & 0x80000:
        raw -= 0x100000
    return raw


def _read_reg16_unsigned(bus, dev_addr: int, reg: int) -> int:
    data = bus.read_i2c_block_data(dev_addr, reg, 3)
    raw = (data[0] << 16) | (data[1] << 8) | data[2]
    return raw >> 4


def _configure_sensor(bus, mux_addr: int, channel: int, ina_addr: int,
                      shunt_cal: int):
    _open_mux_channel(bus, mux_addr, channel)
    _write_reg16(bus, ina_addr, _REG_CONFIG, _CONFIG_VALUE)
    _write_reg16(bus, ina_addr, _REG_SHUNT_CAL, shunt_cal)
    _write_reg16(bus, ina_addr, _REG_DIAG_ALRT, _DIAG_CNVRF)
    _close_mux(bus, mux_addr)


def _read_sensor(bus, mux_addr: int, channel: int, ina_addr: int,
                 current_lsb: float) -> tuple[float, float]:
    """Return (voltage_V, current_uA). Raises OSError on I2C failure."""
    _open_mux_channel(bus, mux_addr, channel)
    vraw = _read_reg16_unsigned(bus, ina_addr, _REG_VBUS)
    iraw = _read_reg16_signed(bus, ina_addr, _REG_CURRENT)
    _close_mux(bus, mux_addr)

    voltage_v = round(vraw * 195.3125e-6, 4)
    current_ua = round(iraw * current_lsb * 1_000_000, 2)
    return voltage_v, current_ua


def _csv_path(log_dir: str, date: str) -> str:
    return os.path.join(log_dir, f"{date}.csv")


CSV_HEADER = ["timestamp", "sensor_id", "label", "voltage_V", "current_uA", "valid"]


def _open_csv(path: str):
    new_file = not os.path.exists(path)
    f = open(path, "a", newline="")
    writer = csv.DictWriter(f, fieldnames=CSV_HEADER)
    if new_file:
        writer.writeheader()
    return f, writer


def _git_commit(cfg: dict):
    script = os.path.join(os.path.dirname(__file__), "scripts", "git_commit_logs.sh")
    try:
        subprocess.run(["bash", script], check=True, timeout=60)
        log.info("git commit + push succeeded")
    except subprocess.CalledProcessError as exc:
        log.warning("git commit/push failed (will retry at next rotation): %s", exc)
    except Exception as exc:
        log.warning("git commit/push error: %s", exc)


def main():
    cfg = _load_config()

    import smbus2  # type: ignore

    bus = smbus2.SMBus(1)

    log_dir = cfg["log_dir"]
    os.makedirs(log_dir, exist_ok=True)

    shunt_ohms = cfg["shunt_ohms"]
    max_amps = cfg["max_expected_amps"]
    current_lsb = max_amps / (2 ** 19)
    shunt_cal = int(13107.2e6 * current_lsb * shunt_ohms)

    ina_addr = 0x40
    enabled_sensors = [s for s in cfg["sensors"] if s.get("enabled", False)]

    # Detect MUX addresses
    mux_addresses = set(int(s["mux_address"], 16) for s in enabled_sensors)
    active_mux = set()
    for mux_addr in mux_addresses:
        try:
            bus.read_byte(mux_addr)
            active_mux.add(mux_addr)
        except OSError:
            log.error("MUX 0x%02X not found on I2C bus — disabling its sensors", mux_addr)

    enabled_sensors = [
        s for s in enabled_sensors
        if int(s["mux_address"], 16) in active_mux
    ]

    # Configure all sensors
    for s in enabled_sensors:
        try:
            _configure_sensor(
                bus, int(s["mux_address"], 16), s["mux_channel"],
                ina_addr, shunt_cal
            )
            log.info("Configured sensor %d (%s)", s["id"], s["label"])
        except OSError as exc:
            log.error("Failed to configure sensor %d: %s", s["id"], exc)

    alerter = Alerter(cfg, log_dir)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    csv_file, csv_writer = _open_csv(_csv_path(log_dir, today))

    interval = cfg["sampling_interval_s"]
    git_interval = cfg["git"].get("commit_interval_s", 0)
    last_git_commit = time.monotonic()
    loop_errors = 0

    log.info(
        "Monitor started: %d sensors, %ds interval", len(enabled_sensors), interval
    )

    while True:
        loop_start = time.monotonic()

        try:
            cycle_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            new_day = datetime.now(timezone.utc).strftime("%Y-%m-%d")

            if new_day != today:
                csv_file.close()
                if cfg["git"]["auto_commit"]:
                    _git_commit(cfg)
                today = new_day
                csv_file, csv_writer = _open_csv(_csv_path(log_dir, today))
                log.info("Rotated to new CSV: %s", today)

            readings = []
            for s in sorted(enabled_sensors, key=lambda x: x["id"]):
                mux_addr = int(s["mux_address"], 16)
                valid = 1
                voltage_v = float("nan")
                current_ua = float("nan")
                try:
                    voltage_v, current_ua = _read_sensor(
                        bus, mux_addr, s["mux_channel"], ina_addr, current_lsb
                    )
                except OSError as exc:
                    log.warning("I2C error sensor %d: %s", s["id"], exc)
                    valid = 0
                    try:
                        _close_mux(bus, mux_addr)
                    except Exception:
                        pass

                row = {
                    "timestamp": cycle_ts,
                    "sensor_id": s["id"],
                    "label": s["label"],
                    "voltage_V": "" if isnan(voltage_v) else voltage_v,
                    "current_uA": "" if isnan(current_ua) else current_ua,
                    "valid": valid,
                }
                csv_writer.writerow(row)
                readings.append({
                    "sensor_id": s["id"],
                    "label": s["label"],
                    "voltage_V": voltage_v,
                    "current_uA": current_ua,
                    "valid": valid,
                })

                if valid and not isnan(current_ua):
                    alerter.push(s["id"], current_ua)

            csv_file.flush()
            alerter.evaluate(readings)

            if git_interval > 0:
                elapsed_git = time.monotonic() - last_git_commit
                if elapsed_git >= git_interval:
                    _git_commit(cfg)
                    last_git_commit = time.monotonic()

            loop_errors = 0

        except Exception as exc:
            loop_errors += 1
            log.exception("Unhandled exception in loop (attempt %d): %s", loop_errors, exc)
            time.sleep(5)
            continue

        elapsed = time.monotonic() - loop_start
        sleep_time = max(0, interval - elapsed)
        time.sleep(sleep_time)


if __name__ == "__main__":
    main()
