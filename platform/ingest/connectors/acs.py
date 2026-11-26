"""ACS 5-year RESIDENT profile of each venue's census tract.

Two access paths, same output:
  * bulk  - table-based Summary File on www2.census.gov (no key; streamed, Hawaii rows only)  [default]
  * api   - api.census.gov (requires CENSUS_API_KEY)
Estimates are stored with their published 90% margins of error. Derived shares use the Census
Bureau's documented MOE formula for proportions (ACS General Handbook, ch. 8):
    MOE_p = sqrt(MOE_num^2 - p^2 * MOE_den^2) / den   (use '+' if the radicand is negative)
These describe people who LIVE in the tract, not venue visitors. No sensitive characteristics
(race, ethnicity, religion, health) are imported.
"""
from __future__ import annotations

import math
import os

import psycopg
import requests
from psycopg.types.json import Jsonb

from .. import hawaii_geo as hg
from ..db import RateLimiter, import_run, with_retries

SOURCE_ID = "census_acs5"
API = "https://api.census.gov/data/{year}/acs/acs5"
BULK = "https://www2.census.gov/programs-surveys/acs/summary_file/{year}/table-based-SF/data/5YRData/acsdt5y{year}-{table}.dat"
_limiter = RateLimiter(0.5)
ACS_NULLS = {"-666666666", "-999999999", "-888888888", "-222222222", "-333333333", "-555555555"}

# raw variables needed (table, variable)
RAW = ["B01003_001", "B01002_001", "B19013_001", "B25010_001", "B08301_001", "B08301_003", "B08301_010", "B08301_019",
       "B25044_001", "B25044_003", "B25044_010"]
# Kept for backwards compatibility with tests/API path
VARS = {"B01003_001": ("acs_population_tract", "people", "Total population"),
        "B19013_001": ("acs_median_hh_income_tract", "USD", "Median household income"),
        "B01002_001": ("acs_median_age_tract", "years", "Median age"),
        "B25010_001": ("acs_avg_household_size_tract", "people", "Average household size")}
# derived shares: metric -> (label, numerator vars, denominator var)
SHARES = {
    "acs_commute_drove_alone_share_tract": ("Workers who drive alone to work", ["B08301_003"], "B08301_001"),
    "acs_commute_transit_share_tract": ("Workers who commute by public transit", ["B08301_010"], "B08301_001"),
    "acs_commute_walk_share_tract": ("Workers who walk to work", ["B08301_019"], "B08301_001"),
    "acs_households_no_vehicle_share_tract": ("Households with no vehicle", ["B25044_003", "B25044_010"], "B25044_001"),
}


class MissingKey(RuntimeError):
    pass


def _val(s):
    return None if s is None or s in ACS_NULLS else float(s)


def fetch_tracts(year: int, key: str, session=requests) -> dict[str, dict[str, tuple[float | None, float | None]]]:
    """API path (requires key)."""
    get = ",".join(f"{v}E,{v}M" for v in VARS)
    def call():
        _limiter.wait()
        r = session.get(API.format(year=year), params={"get": f"NAME,{get}", "for": "tract:*", "in": "state:15", "key": key}, timeout=60, allow_redirects=False)
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
        out[geoid] = {v: (_val(rec.get(f"{v}E")), _val(rec.get(f"{v}M"))) for v in VARS}
    return out


def fetch_tracts_bulk(year: int, session=requests) -> dict[str, dict[str, tuple[float | None, float | None]]]:
    """Bulk path: stream each national table file and keep Hawaii tract rows (GEO_ID 1400000US15...)."""
    out: dict[str, dict] = {}
    for table in sorted({v.split("_")[0].lower() for v in RAW}):
        url = BULK.format(year=year, table=table)

        def call():
            _limiter.wait()
            r = session.get(url, stream=True, timeout=300)
            r.raise_for_status()
            r.encoding = "utf-8"  # server sends no charset; without this iter_lines yields bytes
            lines = r.iter_lines(decode_unicode=True)
            head = next(lines).split("|")
            keep = [ln.split("|") for ln in lines if ln.startswith("1400000US15")]
            return head, keep
        head, rows = with_retries(call, retry_on=(requests.RequestException,))
        idx = {h: i for i, h in enumerate(head)}
        for row in rows:
            geoid = row[0][len("1400000US"):]
            d = out.setdefault(geoid, {})
            for v in RAW:
                t, n = v.split("_")
                if not v.lower().startswith(table):
                    continue
                e, m = f"{t}_E{n}", f"{t}_M{n}"
                if e in idx:
                    d[v] = (_val(row[idx[e]]), _val(row[idx[m]]))
    return out


def share_with_moe(num: list[tuple], den: tuple) -> tuple[float | None, float | None]:
    if den[0] in (None, 0) or any(n[0] is None for n in num):
        return None, None
    ne = sum(n[0] for n in num)
    nm = math.sqrt(sum((n[1] or 0) ** 2 for n in num))  # MOE of a sum: root of summed squares
    p = ne / den[0]
    dm = den[1] or 0
    rad = nm ** 2 - p ** 2 * dm ** 2
    if rad < 0:
        rad = nm ** 2 + p ** 2 * dm ** 2
    return p, math.sqrt(rad) / den[0]


def enrich_venues(conn: psycopg.Connection, year: int = 2024, mode: str | None = None, session=requests) -> dict:
    mode = mode or ("api" if os.environ.get("CENSUS_API_KEY") and os.environ.get("ACS_MODE") == "api" else "bulk")
    if mode == "api":
        key = os.environ.get("CENSUS_API_KEY")
        if not key:
            raise MissingKey("CENSUS_API_KEY not set. Get a free key at https://api.census.gov/data/key_signup.html (or use bulk mode)")
        tracts = fetch_tracts(year, key, session)
    else:
        tracts = fetch_tracts_bulk(year, session)
    with import_run(conn, SOURCE_ID, f"connectors.acs.enrich_venues.{mode}", source_vintage=f"ACS 5-year {year - 4}-{year}") as run, conn.cursor() as cur:
        cur.execute("SELECT id, ST_Y(location::geometry), ST_X(location::geometry), is_demo FROM venue WHERE location IS NOT NULL")
        venues = cur.fetchall()
        run.bump("rows_read", len(venues))
        for vid, lat, lon, demo in venues:
            b = hg.nearest_block(lat, lon)
            t = tracts.get(b.tract) if b else None
            if not t:
                run.bump("rows_rejected"); continue
            rows = [(metric, unit, label, *t.get(v, (None, None))) for v, (metric, unit, label) in VARS.items()]
            for metric, (label, nums, den) in SHARES.items():
                if all(n in t for n in nums) and den in t:
                    rows.append((metric, "share", label, *share_with_moe([t[n] for n in nums], t[den])))
            for metric, unit, label, est, moe in rows:
                flags = []
                if est is not None and moe is not None and est > 0 and (moe / 1.645) / est > 0.3:
                    flags.append("small_sample")  # CV > 30%: unreliable per Census guidance
                cur.execute("SELECT id, value FROM metric_observation WHERE subject_type='venue' AND subject_id=%s AND metric_code=%s AND source_id=%s AND period_end=%s",
                            (str(vid), metric, SOURCE_ID, f"{year}-12-31"))
                ex = cur.fetchone()
                same = ex is not None and ((ex[1] is None and est is None) or (ex[1] is not None and est is not None and abs(float(ex[1]) - est) <= 1e-9 * max(1.0, abs(est))))
                if same:
                    run.bump("rows_unchanged"); continue
                if ex:
                    cur.execute("DELETE FROM metric_observation WHERE id=%s", (ex[0],))
                cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status, source_id,
                                 source_record_ref, import_run_id, formula, uncertainty, allowed_uses, quality_flags, is_demo)
                               VALUES ('venue',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (str(vid), metric, est, unit, f"{year - 4}-01-01", f"{year}-12-31", f"Census tract {b.tract} (residents; venue lies in this tract)",
                             "vendor_modeled" if est is not None else "unavailable", SOURCE_ID, f"ACS5 {year} tract {b.tract}", run.id, label,
                             Jsonb({"moe_90": moe, "type": "Census published margin of error (90%)" if unit != "share" else "derived MOE (Census proportion formula)"}) if moe is not None else None,
                             ["internal", "client_report", "activation", "redistribution"], flags, demo))
                run.bump("rows_updated" if ex else "rows_inserted")
    return {"run_id": run.id, "mode": mode, "tracts": len(tracts), **run.counts}
