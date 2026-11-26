"""Commercial data-provider adapters.

Honest status rules
  * No vendor API is marked working unless a live authenticated call succeeded (see status.py).
  * Vendor export column names could NOT be verified against vendor documentation (vendor sites were
    unreachable from the build environment and require contracts). Each provider therefore maps to a
    JPG *standard provider export* layout (templates/providers/<provider>.csv). An analyst maps the
    vendor's actual export columns to this layout; MAPPING_HINTS records the expected vendor concepts.
  * Only AGGREGATED data is accepted. Files containing person- or device-level identifiers are
    rejected outright (no partial import), so the platform never builds person-level histories.
  * Provider values are stored as value_status='vendor_modeled' with vendor intervals only if the
    vendor supplied them; nothing is invented.
"""
from __future__ import annotations

import csv
import os
import re
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from ..db import import_run, record_exception, sha256_file
from ..matching import match

# Columns that indicate person/device-level data. Any of these -> reject file.
PERSON_LEVEL = re.compile(r"^(e-?mail|hashed_?email|maid|ifa|idfa|gaid|aaid|device_?id|ip(_address)?|phone|first_?name|last_?name|full_?name|"
                          r"street_?address_?home|home_?address|person_?id|user_?id|cookie|hem|lat_?lon_?ping|ping_?time)$", re.I)

PROVIDERS = {
    "placer": {"source_id": "placer", "env": "PLACER_API_KEY",
               "metrics": {"visits": "visits", "unique_visitors": "people", "median_dwell_minutes": "minutes", "visit_frequency": "visits per visitor"},
               "hint": "Placer.ai venue report export: visits, visitors, dwell time, visit frequency for a date range per property."},
    "reveal_mobile": {"source_id": "reveal_mobile", "env": "REVEAL_MOBILE_API_KEY",
                      "metrics": {"exposed_devices": "devices", "attributed_visits": "visits", "visit_rate_exposed": "share", "visit_rate_control": "share", "lift_pct": "percent"},
                      "hint": "Reveal Mobile attribution study summary: exposed vs control visit rates and lift per campaign (aggregated)."},
    "azira": {"source_id": "azira", "env": "AZIRA_API_KEY",
              "metrics": {"visits": "visits", "unique_visitors": "people", "median_dwell_minutes": "minutes"},
              "hint": "Azira location visitation report per place for a date range (aggregated)."},
    "mastercard": {"source_id": "mastercard", "env": None,
                   "metrics": {"spend_index": "index", "transaction_index": "index", "spend_growth_yoy_pct": "percent"},
                   "hint": "Mastercard aggregated spend insights by geography/category; indices only, never cardholder-level."},
    "audiencelab": {"source_id": "audiencelab", "env": "AUDIENCELAB_API_KEY",
                    "metrics": {"segment_size": "people", "segment_share_of_visitors": "share"},
                    "hint": "AudienceLab AGGREGATED segment counts only. Person-level identity files are rejected."},
    "vistar": {"source_id": "vistar_reports", "env": None,
               "metrics": {"impressions_vendor": "impressions", "plays_vendor": "plays", "spend_usd": "USD"},
               "hint": "Vistar campaign delivery report export (by venue/screen and day)."},
    "hivestack": {"source_id": "hivestack_reports", "env": None,
                  "metrics": {"impressions_vendor": "impressions", "plays_vendor": "plays", "spend_usd": "USD"},
                  "hint": "Hivestack campaign delivery report export (by screen and day)."},
}

STANDARD_COLUMNS = ["venue_key", "venue_name", "address", "lat", "lon", "campaign_key", "period_start", "period_end", "metric", "value",
                    "vendor_low", "vendor_high", "sample_size", "vendor_methodology_ref"]


def _read(path: Path) -> list[dict]:
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        import openpyxl
        ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
        it = ws.iter_rows(values_only=True)
        head = [str(h).strip() if h is not None else "" for h in next(it)]
        return [{h: ("" if v is None else str(v)) for h, v in zip(head, row)} for row in it]
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def import_provider_file(conn: psycopg.Connection, provider: str, path: str | Path) -> dict:
    if provider not in PROVIDERS:
        raise ValueError(f"provider must be one of {sorted(PROVIDERS)}")
    spec = PROVIDERS[provider]
    path = Path(path)
    rows = _read(path)
    cols = set(rows[0].keys()) if rows else set()
    pii = sorted(c for c in cols if PERSON_LEVEL.match(c.strip()))
    if pii:
        raise ValueError(f"Rejected: file contains person/device-level columns {pii}. Only aggregated provider data may be imported.")
    missing = {"metric", "value", "period_start", "period_end"} - cols
    if missing:
        raise ValueError(f"Missing columns {sorted(missing)}; map the vendor export to templates/providers/standard_provider_export.csv")
    src = spec["source_id"]
    with import_run(conn, src, f"commercial.{provider}.file", file_name=path.name, file_sha256=sha256_file(path)) as run, conn.cursor() as cur:
        run.bump("rows_read", len(rows))
        cur.execute("SELECT permits_internal_analysis, permits_client_reports, permits_audience_activation, permits_redistribution FROM source_dataset WHERE id=%s", (src,))
        lic = cur.fetchone()
        allowed = [u for u, ok in zip(["internal", "client_report", "activation", "redistribution"], lic) if ok is True]
        if not allowed:
            run.log("License permissions are unknown (pending contract review): values stored but NO use is permitted until the registry is updated.")
        cur.execute("SELECT id, name, ST_Y(location::geometry), ST_X(location::geometry), venue_key FROM venue WHERE is_demo=false")
        venues = cur.fetchall()
        by_key = {v[4]: v[0] for v in venues}
        cands = [{"id": v[0], "name": v[1], "lat": v[2], "lon": v[3]} for v in venues]
        for i, r in enumerate(rows, start=2):
            ref = f"{path.name}!row {i}"
            metric = (r.get("metric") or "").strip()
            if metric not in spec["metrics"]:
                record_exception(cur, "venue", src, ref, "invalid_row", f"metric '{metric}' not in {sorted(spec['metrics'])}", run.id)
                run.bump("rows_rejected"); continue
            try:
                value = float(r["value"])
            except (TypeError, ValueError):
                record_exception(cur, "venue", src, ref, "invalid_row", f"value {r.get('value')!r} is not numeric (blank = unavailable; omit the row)", run.id)
                run.bump("rows_rejected"); continue
            # Resolve subject: campaign-level metrics or venue-level metrics
            if r.get("campaign_key"):
                cur.execute("SELECT id FROM campaign WHERE campaign_key=%s AND is_demo=false", (r["campaign_key"],))
                c = cur.fetchone()
                if not c:
                    record_exception(cur, "conversion", src, ref, "unmatched", f"campaign '{r['campaign_key']}' not found", run.id)
                    run.bump("rows_rejected"); continue
                subject_type, subject_id = "campaign", str(c[0])
            else:
                vid = by_key.get((r.get("venue_key") or "").strip())
                if vid is None:
                    lat = float(r["lat"]) if r.get("lat") else None
                    lon = float(r["lon"]) if r.get("lon") else None
                    m = match(r.get("venue_name") or "", lat, lon, cands)
                    if m["decision"] != "auto":
                        record_exception(cur, "venue", src, ref, "ambiguous_match" if m["decision"] == "review" else "unmatched",
                                         f"{r.get('venue_name')!r}: " + "; ".join(f"{c['name']} ({s})" for s, c in m["ranked"][:3]), run.id,
                                         [c["id"] for _, c in m["ranked"][:3]], [s for s, _ in m["ranked"][:3]])
                        run.bump("rows_rejected"); continue
                    vid = m["best"]["id"]
                subject_type, subject_id = "venue", str(vid)
            unc = None
            if r.get("vendor_low") and r.get("vendor_high"):
                unc = {"low": float(r["vendor_low"]), "high": float(r["vendor_high"]), "type": "vendor-supplied interval", "ref": r.get("vendor_methodology_ref")}
            n = float(r["sample_size"]) if r.get("sample_size") else None
            cur.execute("""SELECT id, value FROM metric_observation WHERE subject_type=%s AND subject_id=%s AND metric_code=%s AND source_id=%s AND period_start=%s AND period_end=%s AND is_demo=false""",
                        (subject_type, subject_id, metric, src, r["period_start"], r["period_end"]))
            ex = cur.fetchone()
            if ex and float(ex[1]) == value:
                run.bump("rows_unchanged"); continue
            if ex:
                cur.execute("UPDATE metric_observation SET value=%s, uncertainty=%s, sample_size=%s, import_run_id=%s, imported_at=now() WHERE id=%s", (value, Jsonb(unc) if unc else None, n, run.id, ex[0]))
                run.bump("rows_updated"); continue
            cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status, source_id,
                             source_record_ref, import_run_id, formula, sample_size, uncertainty, allowed_uses, quality_flags)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'vendor_modeled',%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (subject_type, subject_id, metric, value, spec["metrics"][metric], r["period_start"], r["period_end"], f"{provider} definition of place/campaign",
                         src, ref, run.id, f"vendor methodology: {r.get('vendor_methodology_ref') or 'not supplied'}", n, Jsonb(unc) if unc else None, allowed,
                         ["small_sample"] if n is not None and n < 30 else []))
            run.bump("rows_inserted")
    return {"run_id": run.id, **run.counts}


def api_status(provider: str) -> tuple[str, str]:
    """Returns (connection_status, note) without claiming anything that was not tested."""
    spec = PROVIDERS[provider]
    if not spec["env"]:
        return "needs_subscription", "Licensed file delivery only; import exports with `python -m ingest import-provider`."
    if not os.environ.get(spec["env"]):
        return "needs_credentials", f"Set {spec['env']} after the contract is signed; file import works meanwhile."
    return "configured_untested", f"{spec['env']} is set but no vendor endpoint has been verified against official docs; API sync not implemented. Use file import."
