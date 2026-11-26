"""ACS 5-year resident profile of each venue's census tract (api.census.gov).

Requires CENSUS_API_KEY (free; the API rejects keyless requests as of 2026-11-26).
Stores estimate AND margin of error (MOE, 90% per Census) in metric_observation.uncertainty.
These are RESIDENT characteristics of the tract the venue sits in: NOT venue visitors.
"""
from __future__ import annotations

import os

import psycopg
import requests
from psycopg.types.json import Jsonb

from .. import hawaii_geo as hg
from ..db import RateLimiter, import_run, with_retries

SOURCE_ID = "census_acs5"
BASE = "https://api.census.gov/data/{year}/acs/acs5"
VARS = {  # code -> (metric, unit, label)
    "B01003_001": ("acs_population_tract", "people", "Total population"),
    "B19013_001": ("acs_median_hh_income_tract", "USD", "Median household income"),
    "B01002_001": ("acs_median_age_tract", "years", "Median age"),
    "B25010_001": ("acs_avg_household_size_tract", "people", "Average household size"),
}
_limiter = RateLimiter(0.5)
ACS_NULLS = {"-666666666", "-999999999", "-888888888", "-222222222", "-333333333", "-555555555"}  # Census annotation sentinels


class MissingKey(RuntimeError):
    pass


def fetch_tracts(year: int, key: str, session=requests) -> dict[str, dict[str, tuple[float | None, float | None]]]:
    get = ",".join(f"{v}E,{v}M" for v in VARS)
    def call():
        _limiter.wait()
        r = session.get(BASE.format(year=year), params={"get": f"NAME,{get}", "for": "tract:*", "in": "state:15", "key": key}, timeout=60, allow_redirects=False)
        if r.status_code in (301, 302) and "missing_key" in r.headers.get("location", ""):
            raise MissingKey("Census API rejected the request: missing or invalid key")
        r.raise_for_status()
        return r.json()
    data = with_retries(call, retry_on=(requests.RequestException,))
    head, rows = data[0], data[1:]
    out = {}
    for row in rows:
        rec = dict(zip(head, row))
        geoid = rec["state"] + rec["county"] + rec["tract"]
        vals = {}
        for v in VARS:
            e, m = rec.get(f"{v}E"), rec.get(f"{v}M")
            vals[v] = (None if e in ACS_NULLS or e is None else float(e), None if m in ACS_NULLS or m is None else float(m))
        out[geoid] = vals
    return out


def enrich_venues(conn: psycopg.Connection, year: int = 2024, session=requests) -> dict:
    key = os.environ.get("CENSUS_API_KEY")
    if not key:
        raise MissingKey("CENSUS_API_KEY not set. Get a free key at https://api.census.gov/data/key_signup.html")
    tracts = fetch_tracts(year, key, session)
    with import_run(conn, SOURCE_ID, "connectors.acs.enrich_venues", source_vintage=f"ACS 5-year {year - 4}-{year}") as run, conn.cursor() as cur:
        cur.execute("SELECT id, ST_Y(location::geometry), ST_X(location::geometry), is_demo FROM venue WHERE location IS NOT NULL")
        venues = cur.fetchall()
        run.bump("rows_read", len(venues))
        for vid, lat, lon, demo in venues:
            b = hg.nearest_block(lat, lon)
            if not b or b.tract not in tracts:
                run.bump("rows_rejected"); continue
            for v, (metric, unit, label) in VARS.items():
                est, moe = tracts[b.tract][v]
                flags = []
                if est is not None and moe is not None and est > 0 and (moe / 1.645) / est > 0.3:
                    flags.append("small_sample")  # coefficient of variation > 30%: unreliable per Census guidance
                cur.execute("DELETE FROM metric_observation WHERE subject_type='venue' AND subject_id=%s AND metric_code=%s AND source_id=%s AND period_end=%s",
                            (str(vid), metric, SOURCE_ID, f"{year}-12-31"))
                cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status, source_id,
                                 source_record_ref, import_run_id, formula, uncertainty, allowed_uses, quality_flags, is_demo)
                               VALUES ('venue',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (str(vid), metric, est, unit, f"{year - 4}-01-01", f"{year}-12-31", f"Census tract {b.tract} (residents; venue lies in this tract)",
                             "vendor_modeled" if est is not None else "unavailable", SOURCE_ID, f"ACS5 {year} {v}E tract {b.tract}", run.id, label,
                             Jsonb({"moe_90": moe, "type": "Census published margin of error (90%)"}) if moe is not None else None,
                             ["internal", "client_report", "activation", "redistribution"], flags, demo))
                run.bump("rows_inserted")
    return {"run_id": run.id, **run.counts}
