"""INA228 debug & hardware validation CLI."""

import csv
import os
import sys
import time
from collections import deque
from datetime import datetime, timezone
from math import isnan

import click
import yaml

try:
    import smbus2  # type: ignore
    _HAS_SMBUS = True
except ImportError:
    _HAS_SMBUS = False

try:
    from rich.console import Console
    from rich.table import Table
    from rich.live import Live
    from rich import print as rprint
    _HAS_RICH = True
except ImportError:
    _HAS_RICH = False

_REG_CONFIG    = 0x00
_REG_SHUNT_CAL = 0x02
_REG_VBUS      = 0x05
_REG_CURRENT   = 0x07
_REG_DIAG_ALRT = 0x0B
_CONFIG_VALUE  = 0xFB34
_DIAG_CNVRF    = 0x0001

console = Console() if _HAS_RICH else None


def load_config(ctx, param, value):
    path = value or "config.yaml"
    if not os.path.exists(path):
        click.echo(f"ERROR: config file not found: {path}", err=True)
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


def get_bus():
    if not _HAS_SMBUS:
        click.echo("smbus2 not installed. Run: pip install smbus2", err=True)
        sys.exit(1)
    return smbus2.SMBus(1)


def shunt_cal_value(cfg):
    current_lsb = cfg["max_expected_amps"] / (2 ** 19)
    return int(13107.2e6 * current_lsb * cfg["shunt_ohms"]), current_lsb


def open_mux(bus, mux_addr, channel):
    bus.write_byte(mux_addr, 1 << channel)


def close_mux(bus, mux_addr):
    bus.write_byte(mux_addr, 0x00)


def read_raw(bus, addr, reg, n=3):
    return bus.read_i2c_block_data(addr, reg, n)


def parse_vbus(data):
    raw = ((data[0] << 16) | (data[1] << 8) | data[2]) >> 4
    return round(raw * 195.3125e-6, 4)


def parse_current(data, current_lsb):
    raw = ((data[0] << 16) | (data[1] << 8) | data[2]) >> 4
    if raw & 0x80000:
        raw -= 0x100000
    return round(abs(raw * current_lsb * 1_000_000), 2)


# -----------------------------------------------------------------------
@click.group()
@click.option("--config", default="config.yaml", help="Path to config.yaml")
@click.pass_context
def cli(ctx, config):
    ctx.ensure_object(dict)
    click.echo("=" * 50)
    click.echo("  INA228 Monitor — debug.py")
    click.echo(f"  smbus2 : {'OK' if _HAS_SMBUS else 'NOT INSTALLED'}")
    click.echo(f"  rich   : {'OK' if _HAS_RICH else 'not installed (plain output)'}")
    click.echo("=" * 50)
    if not os.path.exists(config):
        click.echo(f"ERROR: {config} not found", err=True)
        sys.exit(1)
    with open(config) as f:
        ctx.obj["cfg"] = yaml.safe_load(f)
    click.echo(f"  Config : {os.path.abspath(config)}")
    enabled = [s for s in ctx.obj["cfg"]["sensors"] if s.get("enabled")]
    click.echo(f"  Sensors: {len(enabled)} enabled of {len(ctx.obj['cfg']['sensors'])} configured")
    click.echo("")


@cli.command()
@click.pass_context
def scan(ctx):
    """Full I2C bus scan; highlights expected MUX and INA228 addresses."""
    bus = get_bus()
    found = []
    click.echo("Scanning I2C bus 1 (0x03–0x77)...")
    for addr in range(3, 0x78):
        try:
            bus.read_byte(addr)
            found.append(addr)
        except OSError:
            pass

    expected = {0x70: "MUX-A (sensors 1–8)", 0x71: "MUX-B (sensors 9–16)", 0x40: "INA228"}
    missing  = [f"0x{a:02X} ({expected[a]})" for a in expected if a not in found]

    click.echo(f"Found {len(found)} device(s):")
    for addr in found:
        tag = expected.get(addr, "UNKNOWN")
        marker = "  [OK]" if addr in expected else "  [?? UNEXPECTED]"
        click.echo(f"  0x{addr:02X}  {tag}{marker}")
    if not found:
        click.echo("  No devices found — check wiring and I2C enabled (raspi-config)")
    if missing:
        click.echo("Expected but NOT found:")
        for m in missing:
            click.echo(f"  [MISSING] {m}")
    else:
        click.echo("All expected devices present.")
    bus.close()


@cli.command()
@click.argument("sensor_id", type=int)
@click.option("--interval", default=5, help="Sample interval in ms (default 5)")
@click.option("--avg-window", default=150, help="Rolling average window in samples (default 150 = 750ms at 5ms)")
@click.option("--verbose", is_flag=True)
@click.pass_context
def sensor(ctx, sensor_id, interval, avg_window, verbose):
    """Read SENSOR_ID continuously, printing raw + rolling average every INTERVAL ms (default 5ms)."""
    cfg = ctx.obj["cfg"]
    s = next((x for x in cfg["sensors"] if x["id"] == sensor_id), None)
    if s is None:
        click.echo(f"Sensor {sensor_id} not in config", err=True)
        sys.exit(1)

    bus = get_bus()
    shunt_cal, current_lsb = shunt_cal_value(cfg)
    mux_addr = int(s["mux_address"], 16)
    interval_s = interval / 1000.0
    sample_count = 0
    window_ms = avg_window * interval
    i_buf: deque = deque(maxlen=avg_window)

    click.echo(f"Reading sensor {sensor_id} ({s['label']}) every {interval}ms — Ctrl-C to stop")
    click.echo(f"  MUX: {s['mux_address']}  channel: {s['mux_channel']}  INA228: 0x40")
    click.echo(f"  Rolling average window: {avg_window} samples ({window_ms}ms)")
    click.echo("")
    click.echo(f"  {'#':<6}  {'Timestamp':<15}  {'Voltage (V)':>12}  {'Raw (µA)':>10}  {'Avg (µA)':>10}")
    click.echo(f"  {'-'*6}  {'-'*15}  {'-'*12}  {'-'*10}  {'-'*10}")
    while True:
        t_start = time.monotonic()
        try:
            open_mux(bus, mux_addr, s["mux_channel"])
            if verbose:
                vbus_raw = read_raw(bus, 0x40, _REG_VBUS)
                iraw     = read_raw(bus, 0x40, _REG_CURRENT)
                click.echo(f"  VBUS raw: {vbus_raw.hex()}  CURRENT raw: {iraw.hex()}")
            v = parse_vbus(read_raw(bus, 0x40, _REG_VBUS))
            i = parse_current(read_raw(bus, 0x40, _REG_CURRENT), current_lsb)
            close_mux(bus, mux_addr)
            i_buf.append(i)
            avg = sum(i_buf) / len(i_buf)
            sample_count += 1
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
            click.echo(f"  {sample_count:<6}  {ts:<15}  {v:>12.4f}  {i:>10.2f}  {avg:>10.2f}")
        except OSError as exc:
            click.echo(f"  I2C error: {exc}", err=True)
        elapsed = time.monotonic() - t_start
        time.sleep(max(0, interval_s - elapsed))


@cli.command(name="all")
@click.pass_context
def all_sensors(ctx):
    """Single-shot read of all enabled sensors."""
    cfg = ctx.obj["cfg"]
    bus = get_bus()
    shunt_cal, current_lsb = shunt_cal_value(cfg)

    if _HAS_RICH:
        table = Table(title="INA228 — All Sensors")
        for col in ["ID", "Label", "MUX", "Ch", "Voltage (V)", "Current (µA)", "Status"]:
            table.add_column(col)
    else:
        click.echo(f"{'ID':>3}  {'Label':<10}  {'Voltage':>10}  {'Current':>12}  Status")

    for s in sorted(cfg["sensors"], key=lambda x: x["id"]):
        if not s.get("enabled", False):
            continue
        mux_addr = int(s["mux_address"], 16)
        try:
            open_mux(bus, mux_addr, s["mux_channel"])
            v = parse_vbus(read_raw(bus, 0x40, _REG_VBUS))
            i = parse_current(read_raw(bus, 0x40, _REG_CURRENT), current_lsb)
            close_mux(bus, mux_addr)
            status = "OK"
        except OSError as exc:
            v = i = float("nan")
            status = f"ERR: {exc}"
            try:
                close_mux(bus, mux_addr)
            except Exception:
                pass

        if _HAS_RICH:
            table.add_row(
                str(s["id"]), s["label"], s["mux_address"], str(s["mux_channel"]),
                f"{v:.4f}" if not isnan(v) else "NaN",
                f"{i:.2f}" if not isnan(i) else "NaN",
                status,
            )
        else:
            v_str = f"{v:.4f}" if not isnan(v) else "NaN"
            i_str = f"{i:.2f}" if not isnan(i) else "NaN"
            click.echo(f"{s['id']:>3}  {s['label']:<10}  {v_str:>10}  {i_str:>12}  {status}")

    if _HAS_RICH:
        console.print(table)
    bus.close()


@cli.command()
@click.pass_context
def mux_test(ctx):
    """Test each configured MUX port for INA228 ACK."""
    cfg = ctx.obj["cfg"]
    bus = get_bus()
    for s in sorted(cfg["sensors"], key=lambda x: x["id"]):
        if not s.get("enabled", False):
            continue
        mux_addr = int(s["mux_address"], 16)
        try:
            open_mux(bus, mux_addr, s["mux_channel"])
            bus.read_byte(0x40)
            close_mux(bus, mux_addr)
            status = "PASS"
        except OSError as exc:
            status = f"FAIL ({exc})"
            try:
                close_mux(bus, mux_addr)
            except Exception:
                pass
        click.echo(f"Sensor {s['id']:>2} ({s['label']:<10}) MUX {s['mux_address']} ch{s['mux_channel']}: {status}")
    bus.close()


@cli.command()
@click.argument("sensor_id", type=int)
@click.pass_context
def calibrate(ctx, sensor_id):
    """Zero-current baseline calibration for SENSOR_ID."""
    cfg = ctx.obj["cfg"]
    s = next((x for x in cfg["sensors"] if x["id"] == sensor_id), None)
    if s is None:
        click.echo(f"Sensor {sensor_id} not in config", err=True)
        sys.exit(1)
    click.echo(f"Calibrating sensor {sensor_id} ({s['label']})")
    click.echo("Disconnect the load from this channel, then press Enter to continue.")
    input()
    bus = get_bus()
    _, current_lsb = shunt_cal_value(cfg)
    mux_addr = int(s["mux_address"], 16)
    samples = []
    for _ in range(10):
        open_mux(bus, mux_addr, s["mux_channel"])
        i = parse_current(read_raw(bus, 0x40, _REG_CURRENT), current_lsb)
        close_mux(bus, mux_addr)
        samples.append(i)
        time.sleep(0.5)
    offset = sum(samples) / len(samples)
    click.echo(f"Baseline offset: {offset:.2f} µA")
    click.echo("(Manual: add calibration.offset_uA to config.yaml for this sensor)")
    bus.close()


@cli.command()
@click.argument("sensor_id", type=int)
@click.pass_context
def alert_test(ctx, sensor_id):
    """Fill SENSOR_ID rolling deque to threshold+1 to test alert pipeline."""
    from alerter import Alerter
    cfg = ctx.obj["cfg"]
    log_dir = cfg["log_dir"]
    os.makedirs(log_dir, exist_ok=True)
    alerter = Alerter(cfg, log_dir)
    threshold = cfg["alert"]["threshold_ua"]
    fill_value = threshold + 1.0
    window_size = int(cfg["alert"]["window_hours"] * 3600 / cfg["sampling_interval_s"])
    click.echo(f"Filling sensor {sensor_id} deque ({window_size} samples) with {fill_value} µA...")
    for _ in range(window_size):
        alerter.push(sensor_id, fill_value)
    s = next((x for x in cfg["sensors"] if x["id"] == sensor_id), {"label": "test"})
    readings = [{
        "sensor_id": sensor_id,
        "label": s.get("label", "test"),
        "voltage_V": 5.0,
        "current_uA": fill_value,
        "valid": 1,
    }]
    fired = alerter.evaluate(readings)
    click.echo(f"Alert fired: {fired}")
    click.echo(f"alerts.csv: {os.path.join(log_dir, 'alerts.csv')}")
    click.echo(f"ALERTS.md:  {os.path.join(log_dir, 'ALERTS.md')}")


@cli.command(name="alerts")
@click.pass_context
def show_alerts(ctx):
    """Print current alerts.csv and ALERTS.md in the terminal."""
    cfg = ctx.obj["cfg"]
    log_dir = cfg["log_dir"]
    csv_path = os.path.join(log_dir, "alerts.csv")
    md_path = os.path.join(log_dir, "ALERTS.md")
    if os.path.exists(csv_path):
        click.echo("=== alerts.csv ===")
        with open(csv_path) as f:
            click.echo(f.read())
    if os.path.exists(md_path):
        click.echo("=== ALERTS.md ===")
        with open(md_path) as f:
            click.echo(f.read())


@cli.command()
@click.pass_context
def config_check(ctx):
    """Validate config.yaml schema without connecting to hardware."""
    cfg = ctx.obj["cfg"]
    required_top = ["sampling_interval_s", "shunt_ohms", "max_expected_amps",
                    "log_dir", "alert", "git", "sensors"]
    errors = []
    for key in required_top:
        if key not in cfg:
            errors.append(f"Missing top-level key: {key}")

    for i, s in enumerate(cfg.get("sensors", [])):
        for field in ["id", "mux_address", "mux_channel", "enabled", "label"]:
            if field not in s:
                errors.append(f"sensors[{i}] missing field: {field}")

    if errors:
        click.echo(f"config.yaml INVALID — {len(errors)} error(s):")
        for e in errors:
            click.echo(f"  [ERR] {e}", err=True)
        sys.exit(1)
    else:
        click.echo("config.yaml is VALID.")
        cfg = ctx.obj["cfg"]
        click.echo(f"  sampling_interval_s : {cfg['sampling_interval_s']}")
        click.echo(f"  shunt_ohms          : {cfg['shunt_ohms']}")
        click.echo(f"  max_expected_amps   : {cfg['max_expected_amps']}")
        click.echo(f"  alert.enabled       : {cfg['alert']['enabled']}")
        click.echo(f"  alert.threshold_ma  : {cfg['alert']['threshold_ma']}")
        click.echo(f"  git.auto_commit     : {cfg['git']['auto_commit']}")
        enabled = [s for s in cfg["sensors"] if s.get("enabled")]
        click.echo(f"  enabled sensors     : {len(enabled)}")
        for s in enabled:
            click.echo(f"    #{s['id']:>2}  {s['label']:<12}  MUX {s['mux_address']} ch{s['mux_channel']}")


if __name__ == "__main__":
    cli(obj={})
