"""Synthetic demonstration dataset. Isolation rules:
  1. Refuses to run unless ALLOW_DEMO_DATA=1.
  2. Refuses unless the target database name contains 'demo', 'sandbox' or 'test' (never production).
  3. Every row is is_demo=true, source 'demo', and every name starts with 'DEMO'.
Deterministic (seeded) so tests can assert exact values.
"""
from __future__ import annotations

import csv
import os
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .adapters.templates import import_template
from .db import ROOT

DEMO_DIR = ROOT / "data" / "demo"
HST = timezone(timedelta(hours=-10))


def _guard(conn: psycopg.Connection) -> None:
    if os.environ.get("ALLOW_DEMO_DATA") != "1":
        raise RuntimeError("Refusing to load demo data: set ALLOW_DEMO_DATA=1 (sandbox databases only).")
    dbname = conn.info.dbname
    if not any(k in dbname for k in ("demo", "sandbox", "test")):
        raise RuntimeError(f"Refusing to load demo data into database '{dbname}': name must contain demo/sandbox/test.")


def _write(name: str, header: list[str], rows: list[list]) -> Path:
    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    p = DEMO_DIR / f"{name}.csv"
    with open(p, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return p


def build_files(seed: int = 7) -> dict[str, Path]:
    rnd = random.Random(seed)
    tpl = lambda k: next(csv.reader(open(ROOT / "templates" / f"{k}.csv")))  # noqa: E731
    files = {}
    files["venues"] = _write("venues", tpl("venues"), [
        ["demo-cstore-kaimuki", "DEMO C-Store Kaimuki", "gas_station", "DEMO Operator", "DEMO 3500 Waialae Ave", "Honolulu", "96816", "Oahu", 21.2836, -157.8000, "5am-11pm"],
        ["demo-cstore-kalihi", "DEMO C-Store Kalihi", "gas_station", "DEMO Operator", "DEMO 1200 N School St", "Honolulu", "96817", "Oahu", 21.3297, -157.8659, "24 hours"],
        ["demo-hotel-waikiki", "DEMO Hotel Waikiki", "hotel", "DEMO Hotels", "DEMO 2300 Kalakaua Ave", "Honolulu", "96815", "Oahu", 21.2790, -157.8290, "24 hours"],
        ["demo-grocery-hilo", "DEMO Grocery Hilo", "grocery", "DEMO Markets", "DEMO 100 Kanoelehua Ave", "Hilo", "96720", "Hawaii Island", 19.7060, -155.0640, "6am-10pm"],
        ["demo-fleet-oahu", "DEMO Van Fleet Oahu", "transit_fleet", "DEMO Fleet", "", "Honolulu", "", "Oahu", "", "", ""],
    ])
    files["assets"] = _write("assets", tpl("assets"), [
        ["demo-kaimuki-cooler", "demo-cstore-kaimuki", "cstore_screen", "DEMO1", "DEMO Kaimuki Cooler Screen", "In-Store Cooler", "", "", 1920, 1080, "landscape", 15, 120, 8, 1, "operating", 500, "false"],
        ["demo-kaimuki-pump-1", "demo-cstore-kaimuki", "pump_top", "", "DEMO Kaimuki Pump Topper 1", "At Pump", 20, 17, "", "", "", "", "", "", 1, "operating", 500, "false"],
        ["demo-kalihi-register", "demo-cstore-kalihi", "cstore_screen", "DEMO2", "DEMO Kalihi Register Screen", "In-Store Register", "", "", 1080, 1920, "portrait", 15, 90, 6, 1, "operating", 500, "false"],
        ["demo-hotel-lobby-1", "demo-hotel-waikiki", "hotel_screen", "DEMO3", "DEMO Hotel Lobby Screen", "Hotel Interior", "", "", 1920, 1080, "landscape", 15, 180, 12, 1, "operating", 500, "false"],
        ["demo-hilo-checkout", "demo-grocery-hilo", "checkout", "", "DEMO Hilo Checkout Dividers", "Checkout Area", "", "", "", "", "", "", "", "", 1, "operating", 650, "false"],
        ["demo-van-1", "demo-fleet-oahu", "vehicle", "DEMO-VAN-1", "DEMO Wrapped Van 1", "Mobile", 144, 60, "", "", "", "", "", "", 2, "operating", 1500, "false"],
    ])
    files["capacity"] = _write("capacity", tpl("capacity"), [
        ["demo-kaimuki-cooler", "2026-01-01", "2026-12-31", "spot_slot", 8, "DEMO: 120s loop / 15s = 8 slots"],
        ["demo-kalihi-register", "2026-01-01", "2026-12-31", "spot_slot", 6, "DEMO: 90s loop / 15s = 6 slots"],
        ["demo-hotel-lobby-1", "2026-01-01", "2026-12-31", "spot_slot", 12, "DEMO: 180s loop / 15s = 12 slots"],
        ["demo-kaimuki-pump-1", "2026-01-01", "2026-12-31", "face_period", 1, "DEMO: static face"],
        ["demo-hilo-checkout", "2026-01-01", "2026-12-31", "face_period", 1, "DEMO: static face"],
    ])
    files["venue_counts"] = _write("venue_counts", tpl("venue_counts"), [
        ["demo-cstore-kaimuki", "", "venue_visits", 21000, "visits", "2026-10-01", "2026-10-31", "demo", "DEMO synthetic door count", ""],
        ["demo-cstore-kaimuki", "", "operating_hours_per_day", 18, "hours", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
        ["demo-cstore-kaimuki", "", "fueling_transactions", 14500, "transactions", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
        ["demo-cstore-kaimuki", "", "fueling_positions", 8, "positions", "", "", "demo", "DEMO", ""],
        ["demo-cstore-kalihi", "", "venue_visits", 26500, "visits", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
        ["demo-cstore-kalihi", "", "operating_hours_per_day", 24, "hours", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
        ["demo-hotel-waikiki", "", "hotel_occupancy_rate", 0.78, "share", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
        ["demo-hotel-waikiki", "", "operating_hours_per_day", 24, "hours", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
        ["demo-grocery-hilo", "", "register_transactions", 52000, "transactions", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
        ["demo-grocery-hilo", "", "lane_share", 0.6, "share", "2026-10-01", "2026-10-31", "demo", "DEMO", ""],
    ])
    files["campaigns"] = _write("campaigns", tpl("campaigns"), [
        ["demo-plate-lunch-2026-10", "DEMO Plate Lunch Co", "Food & Drink", "DEMO October combo promo", "2026-10-05", "2026-11-01", 2100, "completed", 7,
         "QR code unique to campaign; UTM utm_campaign=demo-plate-lunch; coupon code DEMOLUNCH", "geo_holdout"],
        ["demo-credit-union-2026-12", "DEMO Island Credit Union", "Financial", "DEMO holiday savings proposal", "2026-12-07", "2027-01-03", 3000, "proposed", 14,
         "UTM utm_campaign=demo-cu", "none"],
    ])
    files["bookings"] = _write("bookings", tpl("bookings"), [
        ["demo-b1", "demo-plate-lunch-2026-10", "demo-kaimuki-cooler", "2026-10-05", "2026-11-01", 1, "spot_slot", "confirmed", 500],
        ["demo-b2", "demo-plate-lunch-2026-10", "demo-kalihi-register", "2026-10-05", "2026-11-01", 1, "spot_slot", "confirmed", 500],
        ["demo-b3", "demo-plate-lunch-2026-10", "demo-kaimuki-pump-1", "2026-10-05", "2026-11-01", 1, "face_period", "confirmed", 500],
        ["demo-b4", "demo-credit-union-2026-12", "demo-hotel-lobby-1", "2026-12-07", "2027-01-03", 1, "spot_slot", "hold", 500],
        ["demo-b5", "demo-credit-union-2026-12", "demo-hilo-checkout", "2026-12-07", "2027-01-03", 1, "face_period", "hold", 650],
    ])
    # Proof of play: one play per loop while open, with a few outage days (so verified < scheduled).
    pop = []
    for asset, loop, hours, player in (("demo-kaimuki-cooler", 120, (5, 23), "DEMO-P1"), ("demo-kalihi-register", 90, (0, 24), "DEMO-P2")):
        d = date(2026, 10, 5)
        n = 0
        while d <= date(2026, 11, 1):
            if rnd.random() > 0.06:  # ~6% of days the player was offline
                t = datetime(d.year, d.month, d.day, hours[0], 0, tzinfo=HST)
                end = t + timedelta(hours=hours[1] - hours[0])
                t += timedelta(seconds=rnd.randint(0, loop - 1))
                while t < end:
                    n += 1
                    pop.append([f"{player}-{n:07d}", asset, player, "combo-15s", "demo-plate-lunch-2026-10", t.isoformat(), 15])
                    t += timedelta(seconds=loop)
            d += timedelta(days=1)
    files["proof_of_play"] = _write("proof_of_play", tpl("proof_of_play"), pop)
    conv = []
    for i in range(412):
        t = datetime(2026, 10, 5, 7, tzinfo=HST) + timedelta(minutes=rnd.randint(0, 37 * 24 * 60))
        conv.append([f"qr-{i:05d}", "qr_tracker", "demo-plate-lunch-2026-10", "combo-15s", rnd.choice(["demo-kaimuki-cooler", "demo-kalihi-register"]), "qr_scan", t.isoformat(), "", "", "", "", ""])
    for i in range(160):
        t = datetime(2026, 10, 5, 7, tzinfo=HST) + timedelta(minutes=rnd.randint(0, 30 * 24 * 60))
        conv.append([f"ga4-{i:05d}", "ga4", "demo-plate-lunch-2026-10", "", "", "utm_visit", t.isoformat(), "", "", "jpg_dooh", "qr", "demo-plate-lunch"])
    for i in range(95):  # coupon redemptions in POS, some also reported by GA4 as purchases (same dedup key)
        t = datetime(2026, 10, 6, 11, tzinfo=HST) + timedelta(minutes=rnd.randint(0, 30 * 24 * 60))
        key = f"order-{i:04d}"
        conv.append([f"pos-{i:05d}", "qr_tracker", "demo-plate-lunch-2026-10", "", "", "coupon_redemption", t.isoformat(), 14.5, key, "", "", ""])
        if i % 3 == 0:
            conv.append([f"ga4p-{i:05d}", "ga4", "demo-plate-lunch-2026-10", "", "", "purchase", t.isoformat(), 14.5, key, "jpg_dooh", "qr", "demo-plate-lunch"])
    files["conversions"] = _write("conversions", tpl("conversions"), conv)
    files["invoice_lines"] = _write("invoice_lines", tpl("invoice_lines"), [
        ["DEMO-INV-1", 1, "Invoice", "2026-10-01", "DEMO Plate Lunch Co", "", "C-Store Digital", "DEMO October combo promo - screens", 1000, "demo-plate-lunch-2026-10", "2026-10-05"],
        ["DEMO-INV-1", 2, "Invoice", "2026-10-01", "DEMO Plate Lunch Co", "", "Pump Tops", "DEMO October combo promo - pump top", 500, "demo-plate-lunch-2026-10", "2026-10-05"],
        ["DEMO-INV-2", 1, "Invoice", "2026-09-15", "DEMO Unlinked Customer", "", "Production", "DEMO creative production", 250, "", ""],
    ])
    return files


ORDER = ["venues", "assets", "capacity", "venue_counts", "campaigns", "bookings", "proof_of_play", "conversions", "invoice_lines"]


def load_demo(conn: psycopg.Connection) -> dict:
    _guard(conn)
    files = build_files()
    out = {k: import_template(conn, k, files[k], is_demo=True) for k in ORDER}
    # Verified plays per asset for October flight -> asset-level observations the models consume.
    with conn.cursor() as cur:
        cur.execute("""SELECT p.asset_id, count(*) FROM proof_of_play p WHERE p.is_demo GROUP BY 1""")
        for aid, n in cur.fetchall():
            cur.execute("""DELETE FROM metric_observation WHERE subject_type='asset' AND subject_id=%s AND metric_code='verified_plays' AND is_demo""", (str(aid),))
            cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status, source_id,
                             source_record_ref, formula, allowed_uses, is_demo)
                           VALUES ('asset', %s, 'verified_plays', %s, 'plays', '2026-10-05', '2026-11-01', 'player', 'observed', 'demo', 'proof_of_play rows', 'COUNT(proof_of_play)', %s, true)""",
                        (str(aid), n, ["internal"]))
        # Geo-holdout footfall counts for the DiD demo: 6 test stores vs 6 control stores, 28 days pre / 28 post.
        cur.execute("SELECT id FROM campaign WHERE campaign_key='demo-plate-lunch-2026-10'")
        cid = cur.fetchone()[0]
        cur.execute("DELETE FROM metric_observation WHERE subject_type='campaign' AND subject_id=%s AND is_demo", (str(cid),))
        for code, value in (("lift_test_pre", 16800), ("lift_test_post", 18480), ("lift_control_pre", 16500), ("lift_control_post", 17160)):
            cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status,
                             source_id, source_record_ref, formula, inputs, allowed_uses, is_demo)
                           VALUES ('campaign', %s, %s, %s, 'store visits', %s, %s, 'DEMO 6 test / 6 control stores', 'observed', 'demo', 'DEMO advertiser POS', 'count', %s, %s, true)""",
                        (str(cid), code, value, "2026-09-07" if code.endswith("pre") else "2026-10-05", "2026-10-04" if code.endswith("pre") else "2026-11-01",
                         Jsonb({"units": 6, "days": 28}), ["internal"]))
    conn.commit()
    out["gps"] = _demo_gps(conn)
    return out


def _demo_gps(conn: psycopg.Connection) -> dict:
    """Synthetic van drive along real HPMS Oahu segments (requires `hpms.load_segments` in this DB)."""
    from .adapters.gps import compute_route_exposure, import_gps
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM road_segment")
        if cur.fetchone()[0] == 0:
            return {"skipped": "no road_segment rows; run connectors.hpms.load_segments first"}
        # 3 deterministic Oahu urban arterials with AADT; sample a point every 30 s at ~9 m/s along each.
        cur.execute("""WITH segs AS (SELECT segment_key, ST_GeometryN(geom::geometry,1) g FROM road_segment
                         WHERE island='Oahu' AND aadt BETWEEN 15000 AND 40000 AND ST_Length(geom) BETWEEN 2500 AND 4000 ORDER BY segment_key LIMIT 3)
                       SELECT segment_key, ST_Y(ST_LineInterpolatePoint(g, f::float8)), ST_X(ST_LineInterpolatePoint(g, f::float8))
                       FROM segs, generate_series(0::numeric, 1::numeric, (270.0 / GREATEST(ST_Length(g::geography), 300))::numeric) f ORDER BY segment_key, f""")
        pts = cur.fetchall()
    rows, t = [], datetime(2026, 10, 6, 8, 0, tzinfo=HST)
    for day in range(5):  # five weekday shifts
        t = datetime(2026, 10, 6 + day, 8, 0, tzinfo=HST)
        for _seg, lat, lon in pts:
            rows.append(["demo-van-1", "DEMO-VAN-1", t.isoformat(), round(lat, 6), round(lon, 6)])
            t += timedelta(seconds=30)
    p = _write("vehicle_gps", ["asset_key", "vehicle_id", "recorded_at", "lat", "lon"], rows)
    imp = import_gps(conn, p, is_demo=True)
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM asset WHERE asset_key='demo-van-1' AND is_demo")
        aid = cur.fetchone()[0]
    return {"import": imp, "exposure": compute_route_exposure(conn, aid, "2026-10-06", "2026-10-10")}
