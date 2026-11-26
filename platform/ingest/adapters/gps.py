"""Vehicle GPS logs -> route exposure per HPMS road segment.

Input: templates/vehicle_gps.csv (asset_key, vehicle_id, recorded_at ISO-8601 with offset, lat, lon).
Method (documented in docs/METHODOLOGY.md 3.5):
  * consecutive pings of one asset form an interval; intervals longer than MAX_GAP_S are treated as
    the vehicle being off or out of coverage and are NOT credited (reported as dropped seconds).
  * each interval is credited to the HPMS segment nearest the interval's first ping, if within
    SNAP_M metres; otherwise it is counted as 'unmatched' time (no AADT -> no exposure).
  * stationary intervals (< MIN_MOVE_M moved) are reported separately as parked time.
Output: one metric_observation per asset and period (route_exposure) with per-segment seconds and
AADT in inputs, consumed by lib/measurement vehicleContacts().
"""
from __future__ import annotations

import csv
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .. import hawaii_geo as hg
from ..db import import_run, record_exception, sha256_file
from ..matching import haversine_m

MAX_GAP_S = 120
SNAP_M = 40
MIN_MOVE_M = 15


def import_gps(conn: psycopg.Connection, path: str | Path, *, is_demo: bool = False) -> dict:
    path = Path(path)
    src = "demo" if is_demo else "vehicle_telematics"
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    with import_run(conn, src, "adapters.gps.points", file_name=path.name, file_sha256=sha256_file(path), is_demo=is_demo) as run, conn.cursor() as cur:
        run.bump("rows_read", len(rows))
        assets: dict[str, int | None] = {}
        for i, r in enumerate(rows, start=2):
            key = (r.get("asset_key") or "").strip()
            if key not in assets:
                cur.execute("SELECT a.id FROM asset a WHERE asset_key=%s AND is_demo=%s AND format_code='vehicle'", (key, is_demo))
                row = cur.fetchone()
                assets[key] = row[0] if row else None
            try:
                ts = datetime.fromisoformat(r["recorded_at"])
                lat, lon = float(r["lat"]), float(r["lon"])
                if ts.tzinfo is None:
                    raise ValueError("recorded_at needs a UTC offset")
                if not hg.in_hawaii(lat, lon):
                    raise ValueError("point outside Hawaii")
                if assets[key] is None:
                    raise ValueError(f"unknown vehicle asset '{key}' (format must be 'vehicle')")
            except (ValueError, KeyError) as e:
                record_exception(cur, "asset", src, f"{path.name}!row {i}", "invalid_row", str(e), run.id)
                run.bump("rows_rejected")
                continue
            cur.execute("""INSERT INTO vehicle_gps_point (source_id, asset_id, vehicle_id, recorded_at, location, import_run_id, is_demo)
                           VALUES (%s,%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography,%s,%s)
                           ON CONFLICT (asset_id, recorded_at) DO NOTHING RETURNING id""",
                        (src, assets[key], r.get("vehicle_id"), ts, lon, lat, run.id, is_demo))
            run.bump("rows_inserted" if cur.fetchone() else "rows_unchanged")
    return {"run_id": run.id, **run.counts}


def compute_route_exposure(conn: psycopg.Connection, asset_id: int, period_start: str, period_end: str) -> dict:
    """Aggregates GPS intervals onto nearest road segments for one asset and period (inclusive dates)."""
    with conn.cursor() as cur:
        cur.execute("""SELECT p.recorded_at, ST_Y(p.location::geometry), ST_X(p.location::geometry), s.segment_key, s.aadt, s.route_name,
                              ST_Distance(p.location, s.geom), p.source_id, p.is_demo
                       FROM vehicle_gps_point p
                       LEFT JOIN LATERAL (SELECT segment_key, aadt, route_name, geom FROM road_segment r
                                          WHERE ST_DWithin(r.geom, p.location, %s) ORDER BY r.geom <-> p.location LIMIT 1) s ON true
                       WHERE p.asset_id=%s AND p.recorded_at >= %s::date AND p.recorded_at < (%s::date + 1)
                       ORDER BY p.recorded_at""", (SNAP_M, asset_id, period_start, period_end))
        pts = cur.fetchall()
        if len(pts) < 2:
            return {"asset_id": asset_id, "points": len(pts), "status": "unavailable"}
        seg = defaultdict(lambda: {"seconds": 0.0, "aadt": None, "route_name": None})
        unmatched = parked = dropped = 0.0
        for a, b in zip(pts, pts[1:]):
            gap = (b[0] - a[0]).total_seconds()
            if gap > MAX_GAP_S:
                dropped += gap
                continue
            if haversine_m(a[1], a[2], b[1], b[2]) < MIN_MOVE_M:
                parked += gap
                continue
            if a[3] is None:
                unmatched += gap
                continue
            s = seg[a[3]]
            s["seconds"] += gap
            s["aadt"] = float(a[4]) if a[4] is not None else None
            s["route_name"] = a[5]
        source_id, demo = pts[0][7], pts[0][8]
        segments = [{"segment_key": k, **v} for k, v in sorted(seg.items(), key=lambda kv: -kv[1]["seconds"])]
        moving = sum(s["seconds"] for s in segments)
        inputs = {"segments": segments, "unmatched_seconds": unmatched, "parked_seconds": parked, "gap_seconds_dropped": dropped,
                  "points": len(pts), "max_gap_s": MAX_GAP_S, "snap_m": SNAP_M, "gps_source": source_id, "road_source": "hdot_hpms_2024"}
        cur.execute("DELETE FROM metric_observation WHERE subject_type='asset' AND subject_id=%s AND metric_code='route_exposure' AND period_start=%s AND period_end=%s",
                    (str(asset_id), period_start, period_end))
        cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status, source_id,
                         source_record_ref, formula, inputs, sample_size, allowed_uses, quality_flags, is_demo)
                       VALUES ('asset',%s,'route_exposure',%s,'seconds',%s,%s,'HPMS segments driven','observed',%s,'vehicle_gps_point',%s,%s,%s,%s,%s,%s)""",
                    (str(asset_id), moving, period_start, period_end, source_id,
                     f"GPS intervals <= {MAX_GAP_S}s snapped to nearest HPMS segment within {SNAP_M} m", Jsonb(inputs), len(pts), ["internal", "client_report"],
                     ["small_sample"] if len(pts) < 30 else [], demo))
    conn.commit()
    return {"asset_id": asset_id, "points": len(pts), "moving_on_network_s": moving, "unmatched_s": unmatched, "parked_s": parked, "segments": len(segments)}
