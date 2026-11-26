"""Apollo.io licensed export (companies + contacts) -> advertiser / advertiser_contact.

Contacts are stored only from this authorized export (or the CRM). Nothing about a person is
inferred. Use is gated by the 'apollo' license row (client/redistribution uses unknown until the
contract is reviewed). Expected columns follow Apollo's CSV export naming as commonly delivered;
they are NOT verified against Apollo documentation - adjust COLUMN_MAP if your export differs.
"""
from __future__ import annotations

import csv
from pathlib import Path

import psycopg

from ..db import import_run, sha256_file
from ..matching import normalize_name

COLUMN_MAP = {  # our field -> candidate export headers (first present wins)
    "company": ["Company", "Company Name", "Account Name"],
    "industry": ["Industry"],
    "website": ["Website", "Company Website"],
    "city": ["City", "Company City"],
    "state": ["State", "Company State"],
    "first": ["First Name"], "last": ["Last Name"], "title": ["Title"], "email": ["Email"], "phone": ["Phone", "Corporate Phone"],
    "linkedin": ["Person Linkedin Url", "LinkedIn Url"], "apollo_id": ["Apollo Contact Id", "Apollo Account Id", "Id"],
}


def _get(r: dict, field: str) -> str | None:
    for h in COLUMN_MAP[field]:
        if r.get(h):
            return r[h].strip()
    return None


def import_apollo_export(conn: psycopg.Connection, path: str | Path) -> dict:
    path = Path(path)
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    with import_run(conn, "apollo", "commercial.apollo.export", file_name=path.name, file_sha256=sha256_file(path)) as run, conn.cursor() as cur:
        run.bump("rows_read", len(rows))
        for i, r in enumerate(rows, start=2):
            company = _get(r, "company")
            if not company:
                run.bump("rows_rejected"); run.log(f"row {i}: no company"); continue
            state = (_get(r, "state") or "").lower()
            if state and state not in ("hi", "hawaii"):
                run.bump("rows_rejected"); run.log(f"row {i}: outside Hawaii ({state}) skipped"); continue
            cur.execute("""INSERT INTO advertiser (name, normalized_name, industry, website, source_id) VALUES (%s,%s,%s,%s,'apollo')
                           ON CONFLICT (normalized_name, is_demo) DO UPDATE SET industry=COALESCE(advertiser.industry, EXCLUDED.industry), website=COALESCE(advertiser.website, EXCLUDED.website)
                           RETURNING id, (xmax=0)""", (company, normalize_name(company), _get(r, "industry"), _get(r, "website")))
            aid, inserted = cur.fetchone()
            run.bump("rows_inserted" if inserted else "rows_unchanged")
            if _get(r, "email") or _get(r, "linkedin"):
                ref = _get(r, "apollo_id") or f"{path.name}!{i}"
                cur.execute("SELECT 1 FROM advertiser_contact WHERE source_id='apollo' AND source_record_ref=%s", (ref,))
                if not cur.fetchone():
                    cur.execute("""INSERT INTO advertiser_contact (advertiser_id, full_name, role, email, phone, linkedin_url, source_id, source_record_ref)
                                   VALUES (%s,%s,%s,%s,%s,%s,'apollo',%s)""",
                                (aid, " ".join(x for x in [_get(r, "first"), _get(r, "last")] if x) or None, _get(r, "title"), _get(r, "email"), _get(r, "phone"), _get(r, "linkedin"), ref))
    return {"run_id": run.id, **run.counts}
