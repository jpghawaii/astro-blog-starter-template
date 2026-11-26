"""JPG CSV template importer (templates/*.csv). Validates every row; invalid rows go to the
exceptions queue with a reason instead of being silently dropped or coerced. Idempotent upserts.

Kinds: venues, assets, capacity, campaigns, bookings, proof_of_play, conversions, venue_counts,
invoice_lines, traffic_counts.
"""
from __future__ import annotations

import csv
import re
from datetime import date, datetime
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .. import hawaii_geo as hg
from ..db import ImportRun, import_run, record_exception, sha256_file
from ..matching import normalize_name
from .inventory import upsert_asset, upsert_venue

FORMATS = {"cstore_screen", "pump_top", "checkout", "hotel_screen", "mall_static", "mall_screen", "vehicle"}
EVENT_TYPES = {"qr_scan", "utm_visit", "lead", "purchase", "coupon_redemption", "store_visit"}
COUNT_METRICS = {"venue_visits": "visits", "register_transactions": "transactions", "fueling_transactions": "transactions",
                 "fueling_positions": "positions", "operating_hours_per_day": "hours", "hotel_occupancy_rate": "share",
                 "lane_share": "share", "pedestrians_passing": "people", "verified_plays": "plays", "unique_visitors": "people"}
DESIGNS = {"none", "geo_holdout", "matched_market", "randomized_venue", "pre_post_only"}


class RowError(ValueError):
    pass


def req(r: dict, k: str) -> str:
    v = (r.get(k) or "").strip()
    if not v:
        raise RowError(f"'{k}' is required")
    return v


def opt(r: dict, k: str) -> str | None:
    v = (r.get(k) or "").strip()
    return v or None


def num(r: dict, k: str, *, required=False, minv: float | None = 0, maxv: float | None = None) -> float | None:
    v = opt(r, k)
    if v is None:
        if required:
            raise RowError(f"'{k}' is required")
        return None
    try:
        x = float(v.replace(",", "").replace("$", ""))
    except ValueError as e:
        raise RowError(f"'{k}' is not a number: {v!r}") from e
    if minv is not None and x < minv:
        raise RowError(f"'{k}' must be >= {minv}")
    if maxv is not None and x > maxv:
        raise RowError(f"'{k}' must be <= {maxv}")
    return x


def day(r: dict, k: str, required=True) -> date | None:
    v = opt(r, k)
    if v is None:
        if required:
            raise RowError(f"'{k}' is required (YYYY-MM-DD)")
        return None
    try:
        return date.fromisoformat(v)
    except ValueError as e:
        raise RowError(f"'{k}' must be YYYY-MM-DD, got {v!r}") from e


def ts(r: dict, k: str) -> datetime:
    v = req(r, k)
    try:
        d = datetime.fromisoformat(v)
    except ValueError as e:
        raise RowError(f"'{k}' must be ISO 8601 with offset, got {v!r}") from e
    if d.tzinfo is None:
        raise RowError(f"'{k}' needs a UTC offset (e.g. -10:00 for Hawaii)")
    return d


_LOOKUP_CACHE: dict[tuple, int] = {}


def lookup(cur, table: str, key_col: str, key: str, is_demo: bool) -> int:
    ck = (id(cur.connection), table, key, is_demo)
    if ck in _LOOKUP_CACHE:
        return _LOOKUP_CACHE[ck]
    cur.execute(f"SELECT id FROM {table} WHERE {key_col}=%s AND is_demo=%s", (key, is_demo))
    row = cur.fetchone()
    if not row:
        raise RowError(f"unknown {table} '{key}' (import {table}s first)")
    if table in ("asset", "campaign", "venue"):  # stable surrogate keys; cache per import
        _LOOKUP_CACHE[ck] = row[0]
    return row[0]


_CREATIVE_CACHE: dict[tuple, int] = {}


# ------------------------------------------------------------------------------------------
def _venues(cur, r, run, src, demo):
    lat, lon = num(r, "lat", minv=None), num(r, "lon", minv=None)
    if (lat is None) != (lon is None):
        raise RowError("lat and lon must both be given or both blank")
    if lat is not None and not hg.in_hawaii(lat, lon):
        raise RowError(f"coordinates {lat},{lon} are outside Hawaii")
    island = opt(r, "island")
    if lat is not None and not island:
        b = hg.nearest_block(lat, lon)
        island = hg.island_for(b.county, lat, lon) if b else None
    upsert_venue(cur, {"venue_key": req(r, "venue_key"), "name": req(r, "name"), "venue_type": req(r, "venue_type"),
                       "operator_name": opt(r, "operator_name"), "address": opt(r, "address"), "city": opt(r, "city"), "zip": opt(r, "zip"),
                       "island": island, "lat": lat, "lon": lon, "location_quality": "source_coordinates" if lat is not None else "missing",
                       "hours_text": opt(r, "hours_text"), "status": "unverified"}, run, src, demo)


def _assets(cur, r, run, src, demo):
    fmt = req(r, "format_code")
    if fmt not in FORMATS:
        raise RowError(f"format_code must be one of {sorted(FORMATS)}")
    status = opt(r, "status") or "unverified"
    if status not in {"operating", "unverified", "case_by_case", "inactive", "removed"}:
        raise RowError("invalid status")
    loop, spot = num(r, "loop_length_s"), num(r, "spot_length_s")
    if loop and spot and spot > loop:
        raise RowError("spot_length_s exceeds loop_length_s")
    upsert_asset(cur, {
        "asset_key": req(r, "asset_key"), "venue_id": lookup(cur, "venue", "venue_key", req(r, "venue_key"), demo), "format_code": fmt,
        "operator_frame_id": opt(r, "operator_frame_id"), "name": req(r, "name"), "placement": opt(r, "placement"),
        "is_digital": fmt in {"cstore_screen", "hotel_screen", "mall_screen"}, "width_in": num(r, "width_in"), "height_in": num(r, "height_in"),
        "pixel_width": int(num(r, "pixel_width") or 0) or None, "pixel_height": int(num(r, "pixel_height") or 0) or None,
        "orientation": opt(r, "orientation"), "spot_length_s": spot, "loop_length_s": loop,
        "slots_per_loop": int(num(r, "slots_per_loop") or 0) or None, "faces": int(num(r, "faces") or 1), "status": status,
        "rate_text": None, "rate_4wk_usd": num(r, "rate_4wk_usd"), "rate_source": "template" if opt(r, "rate_4wk_usd") else None,
        "source_record_ref": f"template:{req(r, 'asset_key')}",
        "attributes": {"faces_road": (opt(r, "faces_road") or "").lower() == "true"},
    }, run, src, demo)


def _capacity(cur, r, run, src, demo):
    aid = lookup(cur, "asset", "asset_key", req(r, "asset_key"), demo)
    s, e = day(r, "start_date"), day(r, "end_date")
    if e < s:
        raise RowError("end_date before start_date")
    unit = req(r, "unit")
    if unit not in {"spot_slot", "face_period"}:
        raise RowError("unit must be spot_slot or face_period")
    cap = num(r, "capacity", required=True)
    cur.execute("SELECT id, capacity, basis FROM capacity_period WHERE asset_id=%s AND unit=%s AND period=daterange(%s,%s,'[]')", (aid, unit, s, e))
    ex = cur.fetchone()
    if ex and float(ex[1]) == cap and ex[2] == req(r, "basis"):
        run.bump("rows_unchanged"); return
    cur.execute("SELECT 1 FROM capacity_period WHERE asset_id=%s AND unit=%s AND period && daterange(%s,%s,'[]') AND id <> coalesce(%s,-1)", (aid, unit, s, e, ex[0] if ex else None))
    if cur.fetchone():
        raise RowError("capacity period overlaps an existing period for this asset/unit")
    if ex:
        cur.execute("UPDATE capacity_period SET capacity=%s, basis=%s WHERE id=%s", (cap, req(r, "basis"), ex[0])); run.bump("rows_updated")
    else:
        cur.execute("INSERT INTO capacity_period (asset_id, period, unit, capacity, basis, source_id, is_demo) VALUES (%s, daterange(%s,%s,'[]'), %s, %s, %s, %s, %s)",
                    (aid, s, e, unit, cap, req(r, "basis"), src, demo)); run.bump("rows_inserted")


def _advertiser(cur, name: str, industry: str | None, src: str, demo: bool) -> int:
    n = normalize_name(name)
    cur.execute("""INSERT INTO advertiser (name, normalized_name, industry, is_demo, source_id) VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (normalized_name, is_demo) DO UPDATE SET industry = COALESCE(EXCLUDED.industry, advertiser.industry)
                   RETURNING id""", (name, n, industry, demo, src))
    return cur.fetchone()[0]


def _campaigns(cur, r, run, src, demo):
    s, e = day(r, "flight_start"), day(r, "flight_end")
    if e < s:
        raise RowError("flight_end before flight_start")
    design = opt(r, "experiment_design") or "none"
    if design not in DESIGNS:
        raise RowError(f"experiment_design must be one of {sorted(DESIGNS)}")
    adv = _advertiser(cur, req(r, "advertiser_name"), opt(r, "industry"), src, demo)
    vals = (adv, req(r, "campaign_name"), s, e, num(r, "budget_usd"), opt(r, "status") or "planned", int(num(r, "attribution_window_days") or 0) or None,
            opt(r, "matching_method"), design)
    cur.execute("""INSERT INTO campaign (campaign_key, advertiser_id, name, flight, budget_usd, status, attribution_window_days, matching_method, experiment_design, is_demo, source_id)
                   VALUES (%s,%s,%s,daterange(%s,%s,'[]'),%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (campaign_key) DO UPDATE SET advertiser_id=EXCLUDED.advertiser_id, name=EXCLUDED.name, flight=EXCLUDED.flight, budget_usd=EXCLUDED.budget_usd,
                     status=EXCLUDED.status, attribution_window_days=EXCLUDED.attribution_window_days, matching_method=EXCLUDED.matching_method, experiment_design=EXCLUDED.experiment_design
                   WHERE (campaign.advertiser_id, campaign.name, campaign.flight, campaign.budget_usd, campaign.status, campaign.attribution_window_days, campaign.matching_method, campaign.experiment_design)
                     IS DISTINCT FROM (EXCLUDED.advertiser_id, EXCLUDED.name, EXCLUDED.flight, EXCLUDED.budget_usd, EXCLUDED.status, EXCLUDED.attribution_window_days, EXCLUDED.matching_method, EXCLUDED.experiment_design)
                   RETURNING (xmax=0)""", (req(r, "campaign_key"), *vals[:2], vals[2], vals[3], *vals[4:], demo, src))
    _count(cur, run)


def _count(cur, run: ImportRun):
    row = cur.fetchone()
    run.bump("rows_unchanged" if row is None else "rows_inserted" if row[0] else "rows_updated")


def _bookings(cur, r, run, src, demo):
    cid = lookup(cur, "campaign", "campaign_key", req(r, "campaign_key"), demo)
    aid = lookup(cur, "asset", "asset_key", req(r, "asset_key"), demo)
    s, e = day(r, "start_date"), day(r, "end_date")
    if e < s:
        raise RowError("end_date before start_date")
    unit = req(r, "unit")
    cur.execute("SELECT f.capacity_unit FROM asset a JOIN media_format f ON f.code=a.format_code WHERE a.id=%s", (aid,))
    if cur.fetchone()[0] != unit:
        raise RowError(f"unit {unit} does not match the asset format's capacity unit")
    status = opt(r, "status") or "confirmed"
    cur.execute("""INSERT INTO booking (booking_key, campaign_id, asset_id, period, units_booked, unit, status, rate_usd, is_demo, source_id, source_record_ref)
                   VALUES (%s,%s,%s,daterange(%s,%s,'[]'),%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (booking_key) DO UPDATE SET campaign_id=EXCLUDED.campaign_id, asset_id=EXCLUDED.asset_id, period=EXCLUDED.period,
                     units_booked=EXCLUDED.units_booked, unit=EXCLUDED.unit, status=EXCLUDED.status, rate_usd=EXCLUDED.rate_usd
                   WHERE (booking.campaign_id, booking.asset_id, booking.period, booking.units_booked, booking.unit, booking.status, booking.rate_usd)
                     IS DISTINCT FROM (EXCLUDED.campaign_id, EXCLUDED.asset_id, EXCLUDED.period, EXCLUDED.units_booked, EXCLUDED.unit, EXCLUDED.status, EXCLUDED.rate_usd)
                   RETURNING (xmax=0)""", (req(r, "booking_key"), cid, aid, s, e, num(r, "units_booked", required=True), unit, status, num(r, "rate_usd"), demo, src, req(r, "booking_key")))
    _count(cur, run)


def _pop(cur, r, run, src, demo):
    aid = lookup(cur, "asset", "asset_key", req(r, "asset_key"), demo)
    creative_id = None
    if opt(r, "campaign_key") and opt(r, "creative_key"):
        cid = lookup(cur, "campaign", "campaign_key", req(r, "campaign_key"), demo)
        ck = (id(cur.connection), cid, req(r, "creative_key"))
        if ck in _CREATIVE_CACHE:
            creative_id = _CREATIVE_CACHE[ck]
    if opt(r, "campaign_key") and opt(r, "creative_key") and creative_id is None:
        cur.execute("""INSERT INTO creative (campaign_id, creative_key, name, duration_s, is_demo) VALUES (%s,%s,%s,%s,%s)
                       ON CONFLICT (campaign_id, creative_key) DO UPDATE SET duration_s = COALESCE(creative.duration_s, EXCLUDED.duration_s) RETURNING id""",
                    (cid, req(r, "creative_key"), req(r, "creative_key"), num(r, "duration_s"), demo))
        creative_id = cur.fetchone()[0]
        _CREATIVE_CACHE[ck] = creative_id
    cur.execute("""INSERT INTO proof_of_play (source_id, external_event_id, asset_id, player_id, creative_id, creative_ref, played_at, duration_s, import_run_id, is_demo)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (source_id, external_event_id) DO NOTHING RETURNING true""",
                (src, req(r, "event_id"), aid, opt(r, "player_id"), creative_id, opt(r, "creative_key"), ts(r, "played_at"), num(r, "duration_s"), run.id, demo))
    _count(cur, run)


def _conversions(cur, r, run, src, demo):
    et = req(r, "event_type")
    if et not in EVENT_TYPES:
        raise RowError(f"event_type must be one of {sorted(EVENT_TYPES)}")
    source = opt(r, "source") or src
    if not demo:
        cur.execute("SELECT 1 FROM source_dataset WHERE id=%s", (source,))
        if not cur.fetchone():
            raise RowError(f"unknown source '{source}' (register it in source_dataset)")
    cid = lookup(cur, "campaign", "campaign_key", req(r, "campaign_key"), demo) if opt(r, "campaign_key") else None
    aid = lookup(cur, "asset", "asset_key", req(r, "asset_key"), demo) if opt(r, "asset_key") else None
    cur.execute("""INSERT INTO conversion_event (source_id, external_event_id, campaign_id, asset_id, event_type, occurred_at, value_usd, dedup_key, utm_source, utm_medium, utm_campaign, import_run_id, is_demo)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (source_id, external_event_id) DO NOTHING RETURNING true""",
                (source, req(r, "event_id"), cid, aid, et, ts(r, "occurred_at"), num(r, "value_usd"), opt(r, "dedup_key"),
                 opt(r, "utm_source"), opt(r, "utm_medium"), opt(r, "utm_campaign"), run.id, demo))
    _count(cur, run)


def _venue_counts(cur, r, run, src, demo):
    code = req(r, "metric_code")
    if code not in COUNT_METRICS:
        raise RowError(f"metric_code must be one of {sorted(COUNT_METRICS)}")
    unit = opt(r, "unit") or COUNT_METRICS[code]
    value = num(r, "value", required=True, maxv=1 if COUNT_METRICS[code] == "share" else None)
    ps, pe = day(r, "period_start", required=False), day(r, "period_end", required=False)
    if ps and pe and pe < ps:
        raise RowError("period_end before period_start")
    if opt(r, "asset_key"):
        subject_type, subject_id = "asset", str(lookup(cur, "asset", "asset_key", req(r, "asset_key"), demo))
    else:
        subject_type, subject_id = "venue", str(lookup(cur, "venue", "venue_key", req(r, "venue_key"), demo))
    source = "demo" if demo else (opt(r, "source_id") or "venue_provided")
    evidence = req(r, "evidence_ref")
    cur.execute("""SELECT id, value, source_record_ref FROM metric_observation WHERE subject_type=%s AND subject_id=%s AND metric_code=%s AND source_id=%s
                   AND period_start IS NOT DISTINCT FROM %s AND period_end IS NOT DISTINCT FROM %s AND is_demo=%s""",
                (subject_type, subject_id, code, source, ps, pe, demo))
    ex = cur.fetchone()
    if ex and float(ex[1]) == value and ex[2] == evidence:
        run.bump("rows_unchanged"); return
    if ex:
        cur.execute("UPDATE metric_observation SET value=%s, source_record_ref=%s, import_run_id=%s, imported_at=now() WHERE id=%s", (value, evidence, run.id, ex[0]))
        run.bump("rows_updated"); return
    n = num(r, "sample_size")
    cur.execute("""INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status, source_id,
                     source_record_ref, import_run_id, formula, sample_size, allowed_uses, quality_flags, is_demo)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,'venue premises','observed',%s,%s,%s,'reported count',%s,%s,%s,%s)""",
                (subject_type, subject_id, code, value, unit, ps, pe, source, evidence, run.id, n, ["internal"],
                 ["small_sample"] if n is not None and n < 30 else [], demo))
    run.bump("rows_inserted")


def _invoice_lines(cur, r, run, src, demo):
    cid = None
    if opt(r, "campaign_key"):
        cid = lookup(cur, "campaign", "campaign_key", req(r, "campaign_key"), demo)
    source = "demo" if demo else src
    vals = (req(r, "txn_type"), day(r, "txn_date"), opt(r, "customer_name"), opt(r, "customer_external_id"), cid, opt(r, "item_name"),
            opt(r, "description"), num(r, "amount_usd", required=True, minv=None), day(r, "service_date", required=False),
            opt(r, "account_name"), revenue_class(opt(r, "item_name"), opt(r, "account_name")))
    cur.execute("""INSERT INTO invoice_line (source_id, external_txn_id, line_no, txn_type, txn_date, customer_name, customer_external_id, campaign_id, item_name, description, amount_usd, service_date, account_name, revenue_class, import_run_id, is_demo)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (source_id, external_txn_id, line_no) DO UPDATE SET txn_type=EXCLUDED.txn_type, txn_date=EXCLUDED.txn_date, customer_name=EXCLUDED.customer_name,
                     customer_external_id=EXCLUDED.customer_external_id, campaign_id=EXCLUDED.campaign_id, item_name=EXCLUDED.item_name, description=EXCLUDED.description,
                     amount_usd=EXCLUDED.amount_usd, service_date=EXCLUDED.service_date, account_name=EXCLUDED.account_name, revenue_class=EXCLUDED.revenue_class, import_run_id=EXCLUDED.import_run_id
                   WHERE (invoice_line.txn_type, invoice_line.txn_date, invoice_line.customer_name, invoice_line.campaign_id, invoice_line.amount_usd, invoice_line.description, invoice_line.account_name, invoice_line.revenue_class)
                     IS DISTINCT FROM (EXCLUDED.txn_type, EXCLUDED.txn_date, EXCLUDED.customer_name, EXCLUDED.campaign_id, EXCLUDED.amount_usd, EXCLUDED.description, EXCLUDED.account_name, EXCLUDED.revenue_class)
                   RETURNING (xmax=0)""", (source, req(r, "txn_id"), int(num(r, "line_no", required=True)), *vals, run.id, demo))
    _count(cur, run)


def revenue_class(item: str | None, account: str | None) -> str:
    """Classifies an invoice line so tax, discounts and fees are never summed with media revenue."""
    a, i = (account or "").lower(), (item or "").lower()
    if "tax" in a or i.startswith("getax"):
        return "tax"
    if "refund" in a or "allowance" in a or "discount" in i:
        return "discount"
    if "production" in i or "install" in i or "setup" in i:
        return "production"
    if "fee" in i:
        return "fee"
    if a in ("sales", "") or "sales" in a:
        return "media"
    return "other"


def _traffic(cur, r, run, src, demo):
    ct = req(r, "count_type")
    if ct not in {"AADT", "ADT", "hourly", "pedestrian"}:
        raise RowError("count_type must be AADT, ADT, hourly or pedestrian")
    lat, lon = num(r, "lat", minv=None), num(r, "lon", minv=None)
    if lat is None or not hg.in_hawaii(lat, lon):
        raise RowError("valid Hawaii lat/lon required")
    source = "demo" if demo else (opt(r, "source_id") or src)
    cur.execute("""INSERT INTO traffic_count (source_id, station_id, road_name, location, count_type, count_year, value, direction, import_run_id, is_demo)
                   VALUES (%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (source_id, station_id, count_type, count_year, direction) DO UPDATE SET value=EXCLUDED.value, road_name=EXCLUDED.road_name
                   WHERE traffic_count.value IS DISTINCT FROM EXCLUDED.value RETURNING (xmax=0)""",
                (source, req(r, "station_id"), opt(r, "road_name"), lon, lat, ct, int(num(r, "count_year") or 0) or None, num(r, "value", required=True), opt(r, "direction") or "both", run.id, demo))
    _count(cur, run)


HANDLERS = {"venues": _venues, "assets": _assets, "capacity": _capacity, "campaigns": _campaigns, "bookings": _bookings,
            "proof_of_play": _pop, "conversions": _conversions, "venue_counts": _venue_counts, "invoice_lines": _invoice_lines,
            "traffic_counts": _traffic}
DEFAULT_SOURCE = {"proof_of_play": "cms_proof_of_play", "conversions": "qr_tracker", "venue_counts": "venue_provided", "invoice_lines": "quickbooks_online"}


def import_template(conn: psycopg.Connection, kind: str, path: str | Path, *, is_demo: bool = False, source_id: str | None = None) -> dict:
    if kind not in HANDLERS:
        raise ValueError(f"kind must be one of {sorted(HANDLERS)}")
    path = Path(path)
    src = "demo" if is_demo else (source_id or DEFAULT_SOURCE.get(kind, "jpg_csv_template"))
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        expected = set(next(csv.reader(open(Path(__file__).resolve().parents[2] / "templates" / f"{kind}.csv"))))
        missing = expected - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{path.name}: missing columns {sorted(missing)} (see templates/{kind}.csv)")
        rows = list(reader)
    _LOOKUP_CACHE.clear()
    _CREATIVE_CACHE.clear()
    with import_run(conn, src, f"templates.{kind}", file_name=path.name, file_sha256=sha256_file(path), is_demo=is_demo) as run, conn.cursor() as cur:
        run.bump("rows_read", len(rows))
        for i, r in enumerate(rows, start=2):
            cur.execute("SAVEPOINT row_sp")
            try:
                HANDLERS[kind](cur, r, run, src, is_demo)
                cur.execute("RELEASE SAVEPOINT row_sp")
            except RowError as e:
                cur.execute("ROLLBACK TO SAVEPOINT row_sp")
                run.bump("rows_rejected")
                entity = {"proof_of_play": "proof_of_play", "conversions": "conversion", "invoice_lines": "invoice_line", "assets": "asset"}.get(kind, "venue")
                record_exception(cur, entity, src, f"{path.name}!row {i}", "invalid_row", str(e), run.id)
                run.log(f"row {i}: {e}")
    return {"run_id": run.id, **run.counts}
