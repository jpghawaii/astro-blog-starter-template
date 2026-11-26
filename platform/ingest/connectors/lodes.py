"""LEHD LODES8 connector: jobs located near each venue (daytime workforce indicator).

Data: hi_wac_S000_JT00_{year}.csv.gz (workplace area characteristics, all jobs) joined to
hi_xwalk.csv.gz block internal points. For each venue with coordinates we sum C000 (all jobs)
and the industry columns over blocks whose internal point falls within each radius.

What this is NOT: venue visits, visitors, or residents. LODES block counts are noise-infused for
confidentiality, so values are only reported for radii (aggregates of many blocks).
"""
from __future__ import annotations

import csv
import gzip

import psycopg
from psycopg.types.json import Jsonb

from .. import hawaii_geo as hg
from ..db import import_run, sha256_file

SOURCE_ID = "census_lodes8"
RADII_M = (400, 800, 1600)
# NAICS supersectors used by LODES (subset most relevant to advertisers)
INDUSTRY = {
    "CNS07": "Retail Trade", "CNS18": "Accommodation and Food Services", "CNS16": "Health Care and Social Assistance",
    "CNS12": "Professional, Scientific, and Technical Services", "CNS10": "Finance and Insurance",
    "CNS20": "Public Administration", "CNS15": "Educational Services", "CNS04": "Construction",
}


def latest_year(candidates=range(2026, 2018, -1), log=print) -> int:
    for y in candidates:
        try:
            hg.download(f"hi_wac_S000_JT00_{y}.csv.gz", "wac/", log=lambda *_: None)
            return y
        except Exception:  # noqa: BLE001 - try older vintage
            continue
    raise RuntimeError("No LODES8 WAC file found for Hawaii")


def load_wac(year: int) -> dict[str, dict[str, int]]:
    path = hg.download(f"hi_wac_S000_JT00_{year}.csv.gz", "wac/")
    out = {}
    with gzip.open(path, "rt", newline="") as f:
        for r in csv.DictReader(f):
            out[r["w_geocode"]] = {"C000": int(r["C000"]), **{k: int(r[k]) for k in INDUSTRY}}
    return out


def enrich_venues(conn: psycopg.Connection, year: int | None = None, include_demo: bool = False) -> dict:
    year = year or latest_year()
    wac = load_wac(year)
    blocks = hg.blocks()
    wac_path = hg.CACHE / f"hi_wac_S000_JT00_{year}.csv.gz"
    with import_run(conn, SOURCE_ID, "connectors.lodes.enrich_venues", file_name=wac_path.name, file_sha256=sha256_file(wac_path),
                    source_vintage=f"LODES8 WAC {year} (2020 blocks)", params={"radii_m": RADII_M, "blocks": len(blocks)}) as run, conn.cursor() as cur:
        cur.execute("""SELECT id, name, ST_Y(location::geometry), ST_X(location::geometry), is_demo FROM venue
                       WHERE location IS NOT NULL AND (is_demo = false OR %s)""", (include_demo,))
        venues = cur.fetchall()
        run.bump("rows_read", len(venues))
        for vid, name, lat, lon, is_demo in venues:
            hits = hg.blocks_within(lat, lon, max(RADII_M))
            for r in RADII_M:
                inside = [b for b, d in hits if d <= r]
                with_jobs = [wac[b.geoid] for b in inside if b.geoid in wac]
                total = sum(w["C000"] for w in with_jobs)
                flags = []
                if len(inside) < 3:
                    flags.append("small_sample")  # few blocks -> LODES noise dominates
                inputs = {"blocks_in_radius": len(inside), "blocks_with_jobs": len(with_jobs),
                          "industry_jobs": {INDUSTRY[k]: sum(w[k] for w in with_jobs) for k in INDUSTRY}}
                _upsert(cur, vid, r, total, year, inputs, len(inside), flags, is_demo, run)
        run.log(f"enriched {len(venues)} venues with LODES {year}")
    return {"run_id": run.id, "year": year, **run.counts}


def _upsert(cur, vid, r, total, year, inputs, n_blocks, flags, is_demo, run) -> None:
    """One observation per venue x radius x vintage (metric code encodes the radius). Idempotent."""
    cur.execute(
        """SELECT id, value, inputs FROM metric_observation WHERE subject_type='venue' AND subject_id=%s AND metric_code=%s
             AND source_id=%s AND period_start=%s AND is_demo=%s""",
        (str(vid), f"workers_within_{r}m", SOURCE_ID, f"{year}-01-01", is_demo))
    existing = cur.fetchone()
    if existing and float(existing[1]) == float(total):
        run.bump("rows_unchanged")
        return
    if existing:
        cur.execute("UPDATE metric_observation SET value=%s, inputs=%s, import_run_id=%s, imported_at=now(), quality_flags=%s WHERE id=%s",
                    (total, Jsonb(inputs), run.id, flags, existing[0]))
        run.bump("rows_updated")
        return
    cur.execute(
        """INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope,
             value_status, source_id, source_record_ref, import_run_id, formula, inputs, sample_size, allowed_uses, quality_flags, is_demo)
           VALUES ('venue', %s, %s, %s, 'jobs', %s, %s, %s, 'observed', %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (str(vid), f"workers_within_{r}m", total, f"{year}-01-01", f"{year}-12-31", f"{r} m radius of venue point (2020 block internal points)",
         SOURCE_ID, f"hi_wac_S000_JT00_{year}.csv.gz column C000", run.id,
         f"SUM(C000) over 2020 census blocks whose internal point is within {r} m of the venue", Jsonb(inputs), n_blocks,
         ["internal", "client_report", "activation", "redistribution"], flags, is_demo))
    run.bump("rows_inserted")
