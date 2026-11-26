"""Tests each connector with a minimal live call and records the result in source_dataset.
Only a successful call sets 'tested_working'. Nothing else is claimed."""
from __future__ import annotations

import os
from datetime import datetime, timezone

import psycopg
import requests

from .commercial.providers import PROVIDERS, api_status


def _probe(url: str, **kw) -> tuple[bool, str]:
    try:
        r = requests.get(url, timeout=30, allow_redirects=False, **kw)
        return r.status_code == 200, f"HTTP {r.status_code}" + (f" -> {r.headers.get('location')}" if r.is_redirect else "")
    except requests.RequestException as e:
        return False, f"{type(e).__name__}: {e}"[:200]


def check_all(conn: psycopg.Connection) -> dict:
    results: dict[str, tuple[str, str]] = {}
    ok, note = _probe("https://lehd.ces.census.gov/data/lodes/LODES8/hi/hi_xwalk.csv.gz", stream=True)
    results["census_lodes8"] = ("tested_working" if ok else "blocked", note)
    ok, note = _probe("https://geodata.hawaii.gov/arcgis/rest/services/Transportation/MapServer/12?f=json")
    results["hdot_hpms_2024"] = ("tested_working" if ok else "blocked", note)
    from .connectors.dbedt import latest_available
    try:
        y, m, _ = latest_available()
        results["dbedt_visitor_stats"] = ("tested_working", f"hotel performance workbook {y}-{m:02d} downloaded")
    except Exception as e:  # noqa: BLE001
        results["dbedt_visitor_stats"] = ("blocked", f"{type(e).__name__}: {e}"[:200])
    if os.environ.get("CENSUS_API_KEY"):
        ok, note = _probe("https://api.census.gov/data/2024/acs/acs5", params={"get": "NAME", "for": "state:15", "key": os.environ["CENSUS_API_KEY"]})
        results["census_acs5"] = ("tested_working" if ok else "blocked", note)
    else:
        ok, note = _probe("https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01003.dat", stream=True)
        results["census_acs5"] = ("tested_working" if ok else "blocked", f"bulk Summary File {note}; API path would need CENSUS_API_KEY")
    for sid, url in (("bls_qcew", "https://data.bls.gov/cew/data/api/2026/1/area/15003.csv"),
                     ("census_zbp", "https://www2.census.gov/programs-surveys/cbp/datasets/2023/zbp23detail.zip")):
        ok, note = _probe(url, stream=True)
        results[sid] = ("tested_working" if ok else "blocked", note)
    try:
        from .connectors.market import DBEDT_URL
        ok, note = _probe(DBEDT_URL.format(mon="Sep", y=2026), stream=True)
        results["dbedt_visitor_research"] = ("tested_working" if ok else "blocked", f"monthly highlights workbook {note}")
    except Exception as e:  # noqa: BLE001
        results["dbedt_visitor_research"] = ("blocked", str(e)[:200])
    try:
        r = requests.post("https://overpass-api.de/api/interpreter", data={"data": "[out:json];node(1);out;"}, timeout=30)
        results["osm"] = ("tested_working" if r.ok else "blocked", f"Overpass HTTP {r.status_code}")
    except requests.RequestException as e:
        results["osm"] = ("blocked", f"Overpass unreachable: {type(e).__name__}")
    if os.environ.get("MONDAY_API_TOKEN"):
        try:
            r = requests.post("https://api.monday.com/v2", json={"query": "{ me { id } }"}, headers={"Authorization": os.environ["MONDAY_API_TOKEN"]}, timeout=30)
            results["monday_sales"] = ("tested_working" if r.ok and "errors" not in r.json() else "blocked", f"HTTP {r.status_code}")
        except requests.RequestException as e:
            results["monday_sales"] = ("blocked", str(e)[:200])
    else:
        results["monday_sales"] = ("needs_credentials", "MONDAY_API_TOKEN not set; snapshot import available")
    from .internal.quickbooks import configured
    results["quickbooks_online"] = ("configured_untested" if configured() else "needs_credentials",
                                    "QBO OAuth app configured but not yet tested" if configured() else "Intuit OAuth app credentials not set; CSV import available")
    for p, spec in PROVIDERS.items():
        results[spec["source_id"]] = api_status(p)
    results["apollo"] = ("configured_untested", "APOLLO_API_KEY set; API not verified, use licensed export") if os.environ.get("APOLLO_API_KEY") else ("needs_credentials", "APOLLO_API_KEY not set; licensed CSV export import available")
    now = datetime.now(timezone.utc)
    with conn.cursor() as cur:
        for sid, (status, note) in results.items():
            cur.execute("UPDATE source_dataset SET connection_status=%s, connection_notes=%s, connection_tested_at=%s, updated_at=now() WHERE id=%s", (status, note, now, sid))
    conn.commit()
    return {k: {"status": s, "note": n} for k, (s, n) in results.items()}
