"""HDOT HPMS road segments (AADT) via the Hawaii Statewide GIS Program ArcGIS service.

For each venue we query segments within SEARCH_M of the venue point and store:
  * the NEAREST segment's AADT (and route) as 'aadt_nearest_road'
  * all segments within range in inputs, so the analyst can pick the facing road.
AADT counts VEHICLES per day on the road segment (two-way). It is not a count of venue visitors and
says nothing about whether a specific face is visible from that road.
"""
from __future__ import annotations

import math

import psycopg
import requests
from psycopg.types.json import Jsonb

from ..db import RateLimiter, import_run, with_retries

SOURCE_ID = "hdot_hpms_2024"
LAYER = "https://geodata.hawaii.gov/arcgis/rest/services/Transportation/MapServer/12"
SEARCH_M = 60
_limiter = RateLimiter(0.5)


def segments_near(lat: float, lon: float, radius_m: int = SEARCH_M) -> list[dict]:
    def call():
        _limiter.wait()
        r = requests.get(f"{LAYER}/query", params={
            "geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
            "distance": radius_m, "units": "esriSRUnit_Meter", "outFields": "route_id,route_name,aadt,year_record,f_system_t,through_lanes,island",
            "returnGeometry": "true", "outSR": 4326, "f": "json"}, timeout=60)
        r.raise_for_status()
        j = r.json()
        if "error" in j:
            raise RuntimeError(j["error"])
        out = []
        for f in j.get("features", []):
            a = dict(f["attributes"])
            a["distance_m"] = round(min(_point_seg_m(lat, lon, p, q) for path in f["geometry"]["paths"] for p, q in zip(path, path[1:])), 1)
            out.append(a)
        return out
    return with_retries(call)


def _point_seg_m(lat: float, lon: float, p: list, q: list) -> float:
    """Distance from point to segment p-q (lon/lat pairs) using a local equirectangular projection (fine at <1 km)."""
    k = math.cos(math.radians(lat)) * 111_320.0
    px, py = (p[0] - lon) * k, (p[1] - lat) * 110_540.0
    qx, qy = (q[0] - lon) * k, (q[1] - lat) * 110_540.0
    dx, dy = qx - px, qy - py
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(px * dx + py * dy) / (dx * dx + dy * dy)))
    return math.hypot(px + t * dx, py + t * dy)


def enrich_venues(conn: psycopg.Connection) -> dict:
    with import_run(conn, SOURCE_ID, "connectors.hpms.enrich_venues", source_vintage="HPMS Roads 2024", params={"layer": LAYER, "search_m": SEARCH_M}) as run, conn.cursor() as cur:
        cur.execute("SELECT id, ST_Y(location::geometry), ST_X(location::geometry) FROM venue WHERE location IS NOT NULL AND is_demo=false")
        venues = cur.fetchall()
        run.bump("rows_read", len(venues))
        for vid, lat, lon in venues:
            segs = [s for s in segments_near(lat, lon) if s.get("aadt")]
            cur.execute("SELECT id, value, geo_scope FROM metric_observation WHERE subject_type='venue' AND subject_id=%s AND metric_code='aadt_nearest_road' AND source_id=%s",
                        (str(vid), SOURCE_ID))
            existing = cur.fetchone()
            if not segs:
                run.bump("rows_unchanged")  # no road within range: stays absent (unavailable), never 0
                continue
            # Nearest segment = most likely frontage road. All candidates (with distances) are kept in inputs
            # so an analyst can choose the road a specific face actually faces.
            top = min(segs, key=lambda s: s["distance_m"])
            year = top.get("year_record") or 2024
            inputs = {"segments_within_m": SEARCH_M, "segments": segs}
            scope = f"HPMS segment {top['route_id']} ({top.get('route_name') or 'unnamed'}) at {top['distance_m']} m"
            if existing and float(existing[1]) == float(top["aadt"]) and existing[2] == scope:
                run.bump("rows_unchanged")
                continue
            if existing:
                cur.execute("UPDATE metric_observation SET value=%s, inputs=%s, geo_scope=%s, source_record_ref=%s, formula=%s, import_run_id=%s, imported_at=now() WHERE id=%s",
                            (top["aadt"], Jsonb(inputs), f"HPMS segment {top['route_id']} ({top.get('route_name') or 'unnamed'}) at {top['distance_m']} m",
                             f"HPMS route_id={top['route_id']}", f"AADT of nearest HPMS segment ({top['distance_m']} m) among segments within {SEARCH_M} m of venue point", run.id, existing[0]))
                run.bump("rows_updated")
                continue
            cur.execute(
                """INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status,
                     source_id, source_record_ref, import_run_id, formula, inputs, sample_size, allowed_uses, quality_flags)
                   VALUES ('venue', %s, 'aadt_nearest_road', %s, 'vehicles/day', %s, %s, %s, 'observed', %s, %s, %s, %s, %s, NULL, %s, %s)""",
                (str(vid), top["aadt"], f"{year}-01-01", f"{year}-12-31", f"HPMS segment {top['route_id']} ({top.get('route_name') or 'unnamed'}) at {top['distance_m']} m",
                 SOURCE_ID, f"HPMS route_id={top['route_id']}", run.id, f"AADT of nearest HPMS segment ({top['distance_m']} m) among segments within {SEARCH_M} m of venue point",
                 Jsonb(inputs), ["internal", "client_report"], ["boundary_mismatch"] if len(segs) > 1 else []))
            run.bump("rows_inserted")
    return {"run_id": run.id, **run.counts}


def load_segments(conn: psycopg.Connection, page: int = 1000) -> dict:
    """Loads all HPMS road segments (geometry + AADT) for GPS route matching. Idempotent."""
    with import_run(conn, SOURCE_ID, "connectors.hpms.load_segments", source_vintage="HPMS Roads 2024", params={"layer": LAYER}) as run, conn.cursor() as cur:
        offset = 0
        while True:
            def call():
                _limiter.wait()
                r = requests.get(f"{LAYER}/query", params={"where": "1=1", "outFields": "route_id,route_name,bmp,emp,aadt,year_record,f_system_t,island",
                                                           "returnGeometry": "true", "outSR": 4326, "resultOffset": offset, "resultRecordCount": page,
                                                           "orderByFields": "objectid", "f": "json"}, timeout=120)
                r.raise_for_status()
                j = r.json()
                if "error" in j:
                    raise RuntimeError(j["error"])
                return j.get("features", [])
            feats = with_retries(call)
            if not feats:
                break
            for f in feats:
                a = f["attributes"]
                paths = f.get("geometry", {}).get("paths") or []
                if not paths:
                    run.bump("rows_rejected"); continue
                run.bump("rows_read")
                wkt = "MULTILINESTRING(" + ",".join("(" + ",".join(f"{x} {y}" for x, y in p) + ")" for p in paths if len(p) >= 2) + ")"
                key = f"{a['route_id']}:{a.get('bmp')}-{a.get('emp')}"
                cur.execute("""INSERT INTO road_segment (source_id, segment_key, route_id, route_name, island, functional_class, aadt, aadt_year, geom, import_run_id)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,ST_GeogFromText(%s),%s)
                               ON CONFLICT (source_id, segment_key) DO UPDATE SET aadt=EXCLUDED.aadt, aadt_year=EXCLUDED.aadt_year, route_name=EXCLUDED.route_name, geom=EXCLUDED.geom
                               WHERE road_segment.aadt IS DISTINCT FROM EXCLUDED.aadt OR NOT ST_Equals(road_segment.geom::geometry, EXCLUDED.geom::geometry)
                               RETURNING (xmax=0)""",
                            (SOURCE_ID, key, a.get("route_id"), a.get("route_name"), a.get("island"), a.get("f_system_t"),
                             a.get("aadt") or None, a.get("year_record"), "SRID=4326;" + wkt, run.id))
                row = cur.fetchone()
                run.bump("rows_unchanged" if row is None else "rows_inserted" if row[0] else "rows_updated")
            offset += len(feats)
            conn.commit()
    return {"run_id": run.id, **run.counts}
