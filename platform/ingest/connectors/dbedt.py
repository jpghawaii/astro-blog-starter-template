"""DBEDT monthly hotel performance (occupancy by island/region), files.hawaii.gov xlsx.

The first worksheet holds 'Month of <Month YYYY>' with rows per state/class/island/region and
columns Occupancy % (current year, prior year, ...). Figures are sourced by DBEDT from STR, Inc.;
client-report use is therefore left NULL (blocked) in the source registry until terms are confirmed.
"""
from __future__ import annotations

import calendar
import re
import unicodedata
from datetime import date

import openpyxl
import psycopg
import requests
from psycopg.types.json import Jsonb

from ..db import RateLimiter, import_run, sha256_file, with_retries
from ..hawaii_geo import CACHE

SOURCE_ID = "dbedt_visitor_stats"
URL = "https://files.hawaii.gov/dbedt/economic/tourism/hotel-performance/Hotel-performance-{y}-{m:02d}.xlsx"
_limiter = RateLimiter(1.0)
# Region rows we keep (normalized label -> geo key used by the audience model)
REGIONS = {"state of hawaii": "state", "oahu": "Oahu", "waikiki": "Waikiki", "other oahu": "Other Oahu", "maui county": "Maui County",
           "island of hawaii": "Hawaii Island", "kohala coast": "Kohala Coast", "kauai": "Kauai"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    return re.sub(r"\s+", " ", "".join(c for c in s if c.isascii() and c not in "'‘’ʻ")).strip().lower()


def fetch(year: int, month: int):
    dest = CACHE / f"Hotel-performance-{year}-{month:02d}.xlsx"
    if not dest.exists():
        def get():
            _limiter.wait()
            r = requests.get(URL.format(y=year, m=month), timeout=120)
            r.raise_for_status()
            return r.content
        dest.write_bytes(with_retries(get))
    return dest


def latest_available(today: date | None = None, lookback: int = 6):
    d = today or date.today()
    y, m = d.year, d.month
    for _ in range(lookback):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        try:
            return y, m, fetch(y, m)
        except requests.HTTPError:
            continue
    raise RuntimeError("No DBEDT hotel performance workbook found in lookback window")


def parse_month_block(path) -> tuple[str, dict[str, float]]:
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    title, out = None, {}
    for row in ws.iter_rows(values_only=True):
        cells = [c for c in row if c is not None]
        if not cells:
            continue
        if isinstance(cells[0], str) and cells[0].startswith("Month of"):
            title = cells[0]
            continue
        if isinstance(cells[0], str) and cells[0].startswith("Year-To-Date"):
            break  # only the monthly block
        if title and isinstance(cells[0], str) and len(cells) > 1 and isinstance(cells[1], (int, float)):
            key = REGIONS.get(norm(cells[0]))
            if key:
                out[key] = float(cells[1])
    if not title:
        raise ValueError("Unexpected workbook layout: 'Month of' block not found")
    return title, out


def import_hotel_occupancy(conn: psycopg.Connection, year: int | None = None, month: int | None = None) -> dict:
    if year and month:
        path = fetch(year, month)
    else:
        year, month, path = latest_available()
    title, occ = parse_month_block(path)
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    with import_run(conn, SOURCE_ID, "connectors.dbedt.hotel_occupancy", file_name=path.name, file_sha256=sha256_file(path), source_vintage=title) as run, conn.cursor() as cur:
        run.bump("rows_read", len(occ))
        for region, value in occ.items():
            cur.execute("""SELECT id, value FROM metric_observation WHERE subject_type='geo_area' AND subject_id=%s AND metric_code='hotel_occupancy_rate'
                           AND source_id=%s AND period_start=%s""", (f"dbedt_region:{region}", SOURCE_ID, start))
            ex = cur.fetchone()
            if ex and abs(float(ex[1]) - value) < 1e-12:
                run.bump("rows_unchanged")
                continue
            if ex:
                cur.execute("UPDATE metric_observation SET value=%s, import_run_id=%s, imported_at=now() WHERE id=%s", (value, run.id, ex[0]))
                run.bump("rows_updated")
                continue
            cur.execute(
                """INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status,
                     source_id, source_record_ref, import_run_id, formula, inputs, allowed_uses)
                   VALUES ('geo_area', %s, 'hotel_occupancy_rate', %s, 'share', %s, %s, %s, 'vendor_modeled', %s, %s, %s, %s, %s, %s)""",
                (f"dbedt_region:{region}", value, start, end, f"DBEDT hotel region: {region}", SOURCE_ID, f"{path.name} / {title} / {region}",
                 run.id, "STR sample-based occupancy published by DBEDT", Jsonb({"publisher": "DBEDT", "underlying_source": "STR, Inc."}), ["internal"]))
            run.bump("rows_inserted")
    return {"run_id": run.id, "period": title, "regions": occ, **run.counts}
