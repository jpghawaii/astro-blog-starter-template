"""Market context connectors (official public sources, no credentials):

  * DBEDT monthly visitor statistics: arrivals, visitor days, average daily visitor census,
    length of stay and visitor spending, by island (files.hawaii.gov 'monthly-highlights' xlsx).
  * BLS QCEW: jobs, establishments and average weekly wage by county x private supersector
    (data.bls.gov CEW open-data CSV). Suppressed cells (disclosure_code 'N') are UNAVAILABLE, not 0.
  * Census ZIP Business Patterns: establishment counts by ZIP x NAICS (www2.census.gov, annual).

All are aggregate statistics about places and industries, never about individuals. These are
spending / market-size indicators, not card-transaction data (that requires a licensed provider
such as Mastercard).
"""
from __future__ import annotations

import csv
import io
import re
import unicodedata
import zipfile
from datetime import date

import openpyxl
import psycopg
import requests

from ..db import RateLimiter, import_run, sha256_file, with_retries
from ..hawaii_geo import CACHE

_limiter = RateLimiter(1.0)


def _get(url: str, dest=None, stream=False) -> bytes:
    def call():
        _limiter.wait()
        r = requests.get(url, timeout=300)
        r.raise_for_status()
        return r.content
    data = with_retries(call, retry_on=(requests.RequestException,))
    if dest:
        dest.write_bytes(data)
    return data


def _ascii(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    return re.sub(r"\s+", " ", "".join(c for c in s if c.isascii() and c not in "'‘’ʻ")).strip()


def _upsert(cur, run, subject_type, subject_id, metric, value, unit, start, end, scope, status, source, ref, formula, uses, flags=None):
    cur.execute("""SELECT id, value FROM metric_observation WHERE subject_type=%s AND subject_id=%s AND metric_code=%s AND source_id=%s
                   AND period_start=%s AND is_demo=false""", (subject_type, subject_id, metric, source, start))
    ex = cur.fetchone()
    if ex and ((ex[1] is None and value is None) or (ex[1] is not None and value is not None and abs(float(ex[1]) - value) <= 1e-9 * max(1.0, abs(value)))):
        run.bump("rows_unchanged"); return
    if ex:
        cur.execute("DELETE FROM metric_observation WHERE id=%s", (ex[0],))
    cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status,
                     source_id, source_record_ref, import_run_id, formula, allowed_uses, quality_flags)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (subject_type, subject_id, metric, value, unit, start, end, scope, status if value is not None else "unavailable", source, ref, run.id, formula, uses, flags or []))
    run.bump("rows_updated" if ex else "rows_inserted")


# ------------------------------------------------------------------------------ DBEDT visitors
DBEDT_URL = "https://files.hawaii.gov/dbedt/economic/tourism/monthly-highlights/{mon}%20{y}.xlsx"
VISITOR_SECTIONS = {
    "TOTAL EXPENDITURES ($mil.)": ("visitor_expenditures", "USD millions"),
    "TOTAL VISITOR DAYS": ("visitor_days", "visitor-days"),
    "VISITOR ARRIVALS": ("visitor_arrivals", "visitors"),
    "AVERAGE DAILY CENSUS": ("visitor_avg_daily_census", "visitors present per day"),
    "AVERAGE LENGTH OF STAY": ("visitor_avg_length_of_stay", "days"),
    "PER PERSON PER DAY SPENDING ($)": ("visitor_spend_per_person_day", "USD"),
}
ISLANDS = {"oahu": "Oahu", "maui": "Maui", "molokai": "Molokai", "lanai": "Lanai", "kauai": "Kauai", "hawaii island": "Hawaii Island"}


def import_visitor_stats(conn: psycopg.Connection, year: int | None = None, month: int | None = None, lookback: int = 6) -> dict:
    """Latest DBEDT monthly highlights workbook (or a given month) -> island-level visitor metrics."""
    path = None
    d = date.today()
    y, m = (year, month) if year else (d.year, d.month)
    for _ in range(1 if year else lookback):
        if not year:
            m -= 1
            if m == 0:
                y, m = y - 1, 12
        dest = CACHE / f"dbedt-visitors-{y}-{m:02d}.xlsx"
        try:
            if not dest.exists():
                _get(DBEDT_URL.format(mon=date(y, m, 1).strftime("%b"), y=y), dest)
            path = dest
            break
        except Exception:  # noqa: BLE001 - try previous month
            continue
    if path is None:
        raise RuntimeError("No DBEDT monthly visitor workbook found")
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True)["Island"]
    start = date(y, m, 1)
    end = date(y + (m == 12), m % 12 + 1, 1).fromordinal(date(y + (m == 12), m % 12 + 1, 1).toordinal() - 1)
    section, rows = None, []
    for row in ws.iter_rows(values_only=True):
        cells = [c for c in row if c is not None]
        if not cells or not isinstance(cells[0], str):
            continue
        label = cells[0].strip()
        if label in VISITOR_SECTIONS:
            section = VISITOR_SECTIONS[label]
            continue
        if not cells[0].startswith(" ") and label.upper() == label and any(ch.isalpha() for ch in label):
            section = None  # an unmapped section header (e.g. PER TRIP SPENDING): stop assigning rows
            continue
        isl = ISLANDS.get(_ascii(label).lower())
        if section and isl:
            v = cells[1] if len(cells) > 1 else None
            rows.append((isl, section, float(v) if isinstance(v, (int, float)) else None))
    with import_run(conn, "dbedt_visitor_research", "connectors.market.visitor_stats", file_name=path.name, file_sha256=sha256_file(path),
                    source_vintage=f"DBEDT monthly visitor statistics {start:%b %Y} (preliminary)") as run, conn.cursor() as cur:
        run.bump("rows_read", len(rows))
        for isl, (metric, unit), value in rows:
            _upsert(cur, run, "geo_area", f"island:{isl}", metric, value, unit, start, end, f"Island of {isl} (visitors by air)", "vendor_modeled",
                    "dbedt_visitor_research", f"{path.name} / Island sheet", "DBEDT visitor survey statistics (preliminary)", ["internal", "client_report"])
    return {"run_id": run.id, "period": f"{start:%Y-%m}", **run.counts}


# ------------------------------------------------------------------------------ BLS QCEW
QCEW_URL = "https://data.bls.gov/cew/data/api/{y}/{q}/area/{fips}.csv"
COUNTIES = {"15001": "Hawaii County", "15003": "Honolulu County", "15007": "Kauai County", "15009": "Maui County"}
SUPERSECTORS = {"1011": "Natural resources and mining", "1012": "Construction", "1013": "Manufacturing", "1021": "Trade, transportation, and utilities",
                "1022": "Information", "1023": "Financial activities", "1024": "Professional and business services", "1025": "Education and health services",
                "1026": "Leisure and hospitality", "1027": "Other services"}


def import_qcew(conn: psycopg.Connection, year: int | None = None, quarter: int | None = None) -> dict:
    if not year:
        d = date.today()
        cands = [(d.year - (i // 4 + (1 if (d.month - 1) // 3 - i % 4 < 0 else 0)), ((d.month - 1) // 3 - i % 4) % 4 + 1) for i in range(8)]
    else:
        cands = [(year, quarter)]
    data = None
    for y, q in cands:
        try:
            data = {f: _get(QCEW_URL.format(y=y, q=q, fips=f)).decode() for f in COUNTIES}
            break
        except Exception:  # noqa: BLE001 - quarter not yet published
            continue
    if data is None:
        raise RuntimeError("No QCEW quarter found")
    qs = date(y, 3 * q - 2, 1)
    qe = date(y + (q == 4), (3 * q) % 12 + 1, 1).fromordinal(date(y + (q == 4), (3 * q) % 12 + 1, 1).toordinal() - 1)
    with import_run(conn, "bls_qcew", "connectors.market.qcew", source_vintage=f"QCEW {y} Q{q}") as run, conn.cursor() as cur:
        for fips, text in data.items():
            for r in csv.DictReader(io.StringIO(text)):
                if r["own_code"] != "5" or r["agglvl_code"] != "73" or r["industry_code"] not in SUPERSECTORS:
                    continue
                run.bump("rows_read")
                suppressed = r["disclosure_code"] == "N"
                sector = SUPERSECTORS[r["industry_code"]]
                scope = f"{COUNTIES[fips]}, private, {sector}"
                for metric, raw, unit in (("industry_jobs", r["month3_emplvl"], "jobs"), ("industry_establishments", r["qtrly_estabs"], "establishments"),
                                          ("industry_avg_weekly_wage", r["avg_wkly_wage"], "USD/week")):
                    _upsert(cur, run, "geo_area", f"county:{fips}:naics:{r['industry_code']}", metric, None if suppressed else float(raw), unit, qs, qe, scope,
                            "observed", "bls_qcew", f"QCEW {y}Q{q} area {fips} industry {r['industry_code']}", "BLS QCEW (UI-covered employment)",
                            ["internal", "client_report", "activation", "redistribution"], ["suppressed"] if suppressed else [])
    return {"run_id": run.id, "quarter": f"{y}Q{q}", **run.counts}


# ------------------------------------------------------------------------------ ZIP Business Patterns
ZBP_URL = "https://www2.census.gov/programs-surveys/cbp/datasets/{y}/zbp{yy}detail.zip"
# NAICS groups most relevant to JPG advertisers (prefix match on the 6-char ZBP code)
NAICS_GROUPS = {"44----": "Retail trade (44)", "45----": "Retail trade (45)", "722///": "Restaurants and drinking places", "721///": "Accommodation",
                "441///": "Motor vehicle and parts dealers", "457///": "Gasoline stations and fuel dealers", "445///": "Food and beverage retailers",
                "621///": "Ambulatory health care", "522///": "Credit intermediation (banks, credit unions)", "531///": "Real estate",
                "713///": "Amusement, gambling and recreation", "812///": "Personal and laundry services", "------": "All establishments"}


def import_zbp(conn: psycopg.Connection, year: int = 2023) -> dict:
    dest = CACHE / f"zbp{str(year)[2:]}detail.zip"
    if not dest.exists():
        _get(ZBP_URL.format(y=year, yy=str(year)[2:]), dest)
    with zipfile.ZipFile(dest) as z, z.open(z.namelist()[0]) as f:
        rows = [r for r in csv.DictReader(io.TextIOWrapper(f, encoding="latin-1")) if r["stabbr"] == "HI" and r["naics"] in NAICS_GROUPS]
    with import_run(conn, "census_zbp", "connectors.market.zbp", file_name=dest.name, file_sha256=sha256_file(dest), source_vintage=f"ZIP Business Patterns {year}") as run, conn.cursor() as cur:
        run.bump("rows_read", len(rows))
        for r in rows:
            _upsert(cur, run, "geo_area", f"zip:{r['zip']}:naics:{r['naics']}", "establishments", float(r["est"]), "establishments",
                    date(year, 3, 12), date(year, 3, 12), f"ZIP {r['zip']} ({r['city'].title()}), {NAICS_GROUPS[r['naics']]}", "observed", "census_zbp",
                    f"zbp{str(year)[2:]}detail {r['zip']} {r['naics']}", "Census ZBP establishment count (week of March 12)",
                    ["internal", "client_report", "activation", "redistribution"])
    return {"run_id": run.id, "year": year, **run.counts}
