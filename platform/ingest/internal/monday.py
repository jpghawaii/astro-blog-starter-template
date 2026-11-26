"""monday.com JPG Media Sales board -> advertisers + contacts + pipeline (READ-ONLY).

Uses the official GraphQL API (https://api.monday.com/v2) with MONDAY_API_TOKEN. Only queries are
issued; there is no mutation anywhere in this module. Column ids are those of board 18432141829
(read 2026-11-26); unknown columns are ignored.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg
import requests
from psycopg.types.json import Jsonb

from ..db import RateLimiter, import_run, with_retries
from ..matching import normalize_name

API = "https://api.monday.com/v2"
_limiter = RateLimiter(1.0)
COLS = {"dropdown_mm7ev8gr": "industry", "dropdown_mm7e7phs": "inventory_interest", "color_mm7ezfe": "stage", "numeric_mm7e31a3": "est_deal_value",
        "text_mm7exyv2": "website", "text_mm7etgd7": "contact_name", "text_mm7exs44": "contact_role", "email_mm7ed11w": "email",
        "phone_mm7emzy": "phone", "text_mm7e2rxy": "linkedin", "date_mm7e538j": "last_touch", "color_mm7ev0m2": "priority"}
QUERY = """query ($board: [ID!], $cursor: String) { boards(ids: $board) { items_page(limit: 200, cursor: $cursor) {
  cursor items { id name column_values { id text } } } } }"""


def fetch_items(token: str, board_id: str) -> list[dict]:
    items, cursor = [], None
    while True:
        def call():
            _limiter.wait()
            r = requests.post(API, json={"query": QUERY, "variables": {"board": [board_id], "cursor": cursor}},
                              headers={"Authorization": token, "API-Version": "2025-04"}, timeout=60)
            r.raise_for_status()
            j = r.json()
            if "errors" in j:
                raise RuntimeError(j["errors"])
            return j["data"]["boards"][0]["items_page"]
        page = with_retries(call)
        items += page["items"]
        cursor = page["cursor"]
        if not cursor:
            return items


def normalize(items: list[dict]) -> list[dict]:
    out = []
    for it in items:
        rec = {"monday_id": str(it["id"]), "name": it["name"]}
        for cv in it.get("column_values", []):
            if cv["id"] in COLS:
                rec[COLS[cv["id"]]] = cv.get("text") or None
        out.append(rec)
    return out


def load_records(conn: psycopg.Connection, records: list[dict], source_ref: str) -> dict:
    with import_run(conn, "monday_sales", "internal.monday.sales_board", source_vintage=source_ref) as run, conn.cursor() as cur:
        run.bump("rows_read", len(records))
        for rec in records:
            name = rec["name"].strip()
            cur.execute("""INSERT INTO advertiser (name, normalized_name, industry, website, source_id) VALUES (%s,%s,%s,%s,'monday_sales')
                           ON CONFLICT (normalized_name, is_demo) DO UPDATE SET industry=COALESCE(EXCLUDED.industry, advertiser.industry), website=COALESCE(EXCLUDED.website, advertiser.website)
                           RETURNING id, (xmax=0)""", (name, normalize_name(name), rec.get("industry"), rec.get("website")))
            aid, ins = cur.fetchone()
            cur.execute("""INSERT INTO advertiser_identifier (advertiser_id, system, external_id, external_name) VALUES (%s,'monday',%s,%s)
                           ON CONFLICT (system, external_id) DO UPDATE SET advertiser_id=EXCLUDED.advertiser_id, external_name=EXCLUDED.external_name""", (aid, rec["monday_id"], name))
            cur.execute("""SELECT id, value, inputs FROM metric_observation WHERE subject_type='network' AND subject_id=%s AND metric_code='crm_pipeline' AND source_id='monday_sales'""",
                        (f"advertiser:{aid}",))
            ex = cur.fetchone()
            payload = {k: rec.get(k) for k in ("stage", "inventory_interest", "priority", "last_touch")}
            val = float(rec["est_deal_value"]) if rec.get("est_deal_value") else None
            if ex and ex[2] == payload and (ex[1] is None and val is None or ex[1] is not None and val is not None and float(ex[1]) == val):
                run.bump("rows_unchanged")
            elif ex:
                cur.execute("UPDATE metric_observation SET value=%s, value_status=%s, inputs=%s, imported_at=now(), import_run_id=%s WHERE id=%s",
                            (val, "observed" if val is not None else "unavailable", Jsonb(payload), run.id, ex[0])); run.bump("rows_updated")
            else:
                cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, value_status, source_id, source_record_ref, import_run_id, inputs, allowed_uses)
                               VALUES ('network', %s, 'crm_pipeline', %s, 'USD', %s, 'monday_sales', %s, %s, %s, ARRAY['internal'])""",
                            (f"advertiser:{aid}", val, "observed" if val is not None else "unavailable", f"monday item {rec['monday_id']}", run.id, Jsonb(payload)))
                run.bump("rows_inserted")
            if rec.get("email") or rec.get("contact_name"):
                cur.execute("SELECT 1 FROM advertiser_contact WHERE source_id='monday_sales' AND source_record_ref=%s", (rec["monday_id"],))
                if not cur.fetchone():
                    cur.execute("""INSERT INTO advertiser_contact (advertiser_id, full_name, role, email, phone, linkedin_url, source_id, source_record_ref)
                                   VALUES (%s,%s,%s,%s,%s,%s,'monday_sales',%s)""",
                                (aid, rec.get("contact_name"), rec.get("contact_role"), rec.get("email"), rec.get("phone"), rec.get("linkedin"), rec["monday_id"]))
    return {"run_id": run.id, **run.counts}


def sync_sales_board(conn: psycopg.Connection) -> dict:
    token = os.environ.get("MONDAY_API_TOKEN")
    if not token:
        raise RuntimeError("MONDAY_API_TOKEN not set. Alternatively import a snapshot: load_snapshot(conn, 'data/private/monday_sales.json').")
    board = os.environ.get("MONDAY_SALES_BOARD_ID", "18432141829")
    return load_records(conn, normalize(fetch_items(token, board)), f"monday board {board} (live API)")


def load_snapshot(conn: psycopg.Connection, path: str | Path) -> dict:
    """Snapshot JSON exported from the board (same shape as normalize() output)."""
    recs = json.loads(Path(path).read_text())
    return load_records(conn, recs, f"snapshot {Path(path).name}")
