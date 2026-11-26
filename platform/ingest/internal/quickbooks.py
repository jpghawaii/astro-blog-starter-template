"""QuickBooks Online -> invoice_line (READ-ONLY). Never writes to QuickBooks.

Two paths:
  1. API (needs an Intuit developer app: QBO_CLIENT_ID/SECRET/REFRESH_TOKEN/REALM_ID; accounting scope).
     Queries Invoice entities via the documented query endpoint. Not yet tested (no credentials).
  2. Export / snapshot: invoice lines in the templates/invoice_lines.csv layout (works now).
Revenue is reconciled against bookings (lib/reconcile.ts) but never treated as proof of delivery.
"""
from __future__ import annotations

import os

import psycopg
import requests

from ..adapters.templates import import_template
from ..db import RateLimiter, with_retries

TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
API = "https://quickbooks.api.intuit.com/v3/company/{realm}/query"
_limiter = RateLimiter(0.6)


def configured() -> bool:
    return all(os.environ.get(k) for k in ("QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_REFRESH_TOKEN", "QBO_REALM_ID"))


def _access_token() -> str:
    r = requests.post(TOKEN_URL, data={"grant_type": "refresh_token", "refresh_token": os.environ["QBO_REFRESH_TOKEN"]},
                      auth=(os.environ["QBO_CLIENT_ID"], os.environ["QBO_CLIENT_SECRET"]), headers={"Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def fetch_invoices(since: str) -> list[dict]:
    """Read-only SELECT over Invoice. Paged by STARTPOSITION/MAXRESULTS per QBO query language."""
    token, out, start = _access_token(), [], 1
    while True:
        def call():
            _limiter.wait()
            r = requests.get(API.format(realm=os.environ["QBO_REALM_ID"]),
                             params={"query": f"SELECT * FROM Invoice WHERE TxnDate >= '{since}' STARTPOSITION {start} MAXRESULTS 500", "minorversion": "75"},
                             headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, timeout=60)
            r.raise_for_status()
            return r.json().get("QueryResponse", {}).get("Invoice", [])
        page = with_retries(call)
        out += page
        if len(page) < 500:
            return out
        start += 500


def import_export(conn: psycopg.Connection, path: str) -> dict:
    return import_template(conn, "invoice_lines", path, source_id="quickbooks_online")


ITEM_ALIASES = {"hktc": "Hawaii Kai Towne Center", "kmc": "Koko Marina Center"}


def link_invoice_venues(conn: psycopg.Connection) -> dict:
    """Links media invoice lines to venues by item name ('Alohilani Resort - DOOH' -> venue).
    Auto matches are applied; uncertain ones go to the exceptions queue. Network-wide items
    (e.g. 'Advertising Services', 'VIP TRANS') stay unlinked by design."""
    import re as _re
    from ..db import record_exception
    from ..matching import match
    out = {"linked": 0, "review": 0, "unmatched": 0}
    with conn.cursor() as cur:
        cur.execute("SELECT id, name FROM venue WHERE is_demo=false")
        cands = [{"id": i, "name": n, "lat": None, "lon": None} for i, n in cur.fetchall()]
        cur.execute("SELECT DISTINCT item_name FROM invoice_line WHERE revenue_class='media' AND is_demo=false AND item_name IS NOT NULL")
        for (item,) in cur.fetchall():
            base = _re.sub(r"\s*-\s*DOOH$|\s*\(T\)$", "", item).strip()
            base = ITEM_ALIASES.get(base.lower(), base)
            m = match(base, None, None, cands)
            if m["decision"] == "auto":
                cur.execute("UPDATE invoice_line SET venue_id=%s WHERE item_name=%s AND is_demo=false", (m["best"]["id"], item))
                out["linked"] += 1
            else:
                out["review" if m["decision"] == "review" else "unmatched"] += 1
                record_exception(cur, "invoice_line", "quickbooks_online", f"item:{item}", "ambiguous_match" if m["decision"] == "review" else "unmatched",
                                 f"Invoice item '{item}' -> " + "; ".join(f"{c['name']} ({s})" for s, c in m["ranked"][:3]), None,
                                 [c["id"] for _, c in m["ranked"][:3]], [s for s, _ in m["ranked"][:3]])
    conn.commit()
    return out


def sync_customers(conn: psycopg.Connection) -> dict:
    """Creates/links advertiser rows for invoice customers (read-only use of accounting data)."""
    from ..matching import normalize_name
    n = 0
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT customer_name, customer_external_id FROM invoice_line WHERE is_demo=false AND customer_name IS NOT NULL")
        for name, ext in cur.fetchall():
            cur.execute("""INSERT INTO advertiser (name, normalized_name, source_id) VALUES (%s,%s,'quickbooks_online')
                           ON CONFLICT (normalized_name, is_demo) DO UPDATE SET name=advertiser.name RETURNING id""", (name, normalize_name(name)))
            aid = cur.fetchone()[0]
            if ext:
                cur.execute("""INSERT INTO advertiser_identifier (advertiser_id, system, external_id, external_name) VALUES (%s,'quickbooks',%s,%s)
                               ON CONFLICT (system, external_id) DO UPDATE SET advertiser_id=EXCLUDED.advertiser_id""", (aid, ext, name))
            cur.execute("UPDATE invoice_line SET advertiser_id=%s WHERE customer_name=%s AND is_demo=false AND advertiser_id IS DISTINCT FROM %s", (aid, name, aid))
            n += 1
    conn.commit()
    return {"customers": n}
