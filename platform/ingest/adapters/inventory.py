"""Inventory import: Geopath-format master sheet export and the simple JPG inventory template.

Model: venue (place) -> asset (physical face/screen) -> capacity_period (sellable units).
Idempotent: re-importing the same file produces zero inserts/updates.
"""
from __future__ import annotations

import csv
import hashlib
import re
from collections import defaultdict
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .. import hawaii_geo as hg
from ..db import ImportRun, import_run, record_exception, sha256_file
from ..matching import match, normalize_name, slug

FORMAT_MAP = {
    "Gas Station Media (Pump Tops)": "pump_top",
    "C-Store Digital Screen": "cstore_screen",
    "Shopping center static frame": "mall_static",
    "Escalator Wrap": "mall_static",
    "Check Out Counters": "checkout",
    "Grocery Dividers": "checkout",
    "Grocery End Cap": "checkout",
    "Grocery checkout program (format not specified per store)": "checkout",
    "Hotel Digital Screen": "hotel_screen",
    "Food Court Digital Screen": "mall_screen",
    "Children Play Area Digital Screen": "mall_screen",
    "Shuttle Bus Media": "vehicle",
    "Truck-Side Media (Mobile Billboard)": "vehicle",
}
VENUE_TYPE = {"Gas Station": "gas_station", "Shopping Mall": "shopping_center", "Grocery Store": "grocery",
              "Hotel": "hotel", "Transit / Fleet": "transit_fleet"}
DIGITAL_FORMATS = {"cstore_screen", "hotel_screen", "mall_screen"}

ZIP_RE = re.compile(r"\b(967\d\d|968\d\d)\b")
ISLAND_NOTE_RE = re.compile(r"Island listed in kit:\s*([A-Za-z]+)")
ROOMS_RE = re.compile(r"kit:\s*([\d,]+)\s*rooms", re.I)
RATE_RE = re.compile(r"^\$([\d,]+(?:\.\d+)?)\s*(?:each(?: space)?\s*)?(?:/|per)\s*4 weeks", re.I)


def parse_rate(text: str) -> float | None:
    """Parses a per-unit 4-week list rate. Package/per-hotel/per-combo rates are NOT parsed (left NULL)."""
    m = RATE_RE.match((text or "").strip())
    return float(m.group(1).replace(",", "")) if m else None


def fnum(s: str) -> float | None:
    try:
        return float(str(s).strip()) if str(s).strip() else None
    except ValueError:
        return None


def upsert_venue(cur: psycopg.Cursor, v: dict, run: ImportRun, source_id: str, is_demo: bool = False) -> int:
    cur.execute(
        """INSERT INTO venue (venue_key, name, venue_type, operator_name, address, city, state, zip, island, location,
                              location_quality, hours_text, status, is_demo, source_id, import_run_id)
           VALUES (%(venue_key)s,%(name)s,%(venue_type)s,%(operator_name)s,%(address)s,%(city)s,'HI',%(zip)s,%(island)s,
                   CASE WHEN %(lat)s::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(%(lon)s::float8,%(lat)s::float8),4326)::geography END,
                   %(location_quality)s,%(hours_text)s,%(status)s,%(is_demo)s,%(source_id)s,%(run)s)
           ON CONFLICT (venue_key) DO UPDATE SET
             name=EXCLUDED.name, venue_type=EXCLUDED.venue_type, operator_name=EXCLUDED.operator_name,
             address=EXCLUDED.address, city=EXCLUDED.city, zip=EXCLUDED.zip, island=EXCLUDED.island,
             -- never overwrite a better (geocoded/surveyed) location with a missing one
             location=COALESCE(EXCLUDED.location, venue.location),
             location_quality=CASE WHEN EXCLUDED.location IS NULL THEN venue.location_quality ELSE EXCLUDED.location_quality END,
             hours_text=EXCLUDED.hours_text, import_run_id=EXCLUDED.import_run_id, updated_at=now()
           WHERE (venue.name, venue.venue_type, venue.operator_name, venue.address, venue.city, venue.zip, venue.island, venue.hours_text)
                 IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.venue_type, EXCLUDED.operator_name, EXCLUDED.address, EXCLUDED.city, EXCLUDED.zip, EXCLUDED.island, EXCLUDED.hours_text)
              OR (EXCLUDED.location IS NOT NULL AND NOT ST_DWithin(EXCLUDED.location, COALESCE(venue.location, 'POINT(0 0)'::geography), 1))
           RETURNING id, (xmax = 0) AS inserted""",
        {**v, "is_demo": is_demo, "source_id": source_id, "run": run.id},
    )
    row = cur.fetchone()
    if row is None:
        run.bump("rows_unchanged")
        cur.execute("SELECT id FROM venue WHERE venue_key=%s", (v["venue_key"],))
        return cur.fetchone()[0]
    run.bump("rows_inserted" if row[1] else "rows_updated")
    return row[0]


ASSET_COLS = ["venue_id", "format_code", "operator_frame_id", "name", "placement", "is_digital", "width_in", "height_in",
              "pixel_width", "pixel_height", "orientation", "spot_length_s", "loop_length_s", "slots_per_loop", "faces",
              "status", "rate_text", "rate_4wk_usd", "rate_source", "source_record_ref"]


def upsert_asset(cur: psycopg.Cursor, a: dict, run: ImportRun, source_id: str, is_demo: bool = False) -> int:
    params = {k: a.get(k) for k in ASSET_COLS}
    params.update(asset_key=a["asset_key"], attributes=Jsonb(a.get("attributes", {})), is_demo=is_demo, source_id=source_id, run=run.id)
    params["faces"] = params["faces"] or 1
    cols = ", ".join(ASSET_COLS)
    vals = ", ".join(f"%({c})s" for c in ASSET_COLS)
    sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in ASSET_COLS)
    diff_old = ", ".join(f"asset.{c}" for c in ASSET_COLS)
    diff_new = ", ".join(f"EXCLUDED.{c}" for c in ASSET_COLS)
    cur.execute(
        f"""INSERT INTO asset (asset_key, {cols}, attributes, is_demo, source_id, import_run_id)
            VALUES (%(asset_key)s, {vals}, %(attributes)s, %(is_demo)s, %(source_id)s, %(run)s)
            ON CONFLICT (asset_key) DO UPDATE SET {sets}, attributes=EXCLUDED.attributes, import_run_id=EXCLUDED.import_run_id, updated_at=now()
            WHERE ({diff_old}, asset.attributes) IS DISTINCT FROM ({diff_new}, EXCLUDED.attributes)
            RETURNING id, (xmax = 0)""",
        params,
    )
    row = cur.fetchone()
    if row is None:
        run.bump("rows_unchanged")
        cur.execute("SELECT id FROM asset WHERE asset_key=%s", (a["asset_key"],))
        return cur.fetchone()[0]
    run.bump("rows_inserted" if row[1] else "rows_updated")
    return row[0]


def ensure_static_capacity(cur: psycopg.Cursor, asset_id: int, faces: int, source_id: str, year_start: str, year_end: str) -> None:
    """Static faces: capacity = number of faces, one advertiser per face per period. Idempotent."""
    cur.execute("SELECT 1 FROM capacity_period WHERE asset_id=%s AND unit='face_period' AND period && daterange(%s,%s,'[]')",
                (asset_id, year_start, year_end))
    if cur.fetchone():
        return
    cur.execute("""INSERT INTO capacity_period (asset_id, period, unit, capacity, basis, source_id)
                   VALUES (%s, daterange(%s,%s,'[]'), 'face_period', %s, %s, %s)""",
                (asset_id, year_start, year_end, faces, "Static face: one advertiser per face at a time (JPG standard 4-week cycle).", source_id))


# ---------------------------------------------------------------------------------------------
# Geopath-format master inventory
# ---------------------------------------------------------------------------------------------

def _row_location(r: dict) -> tuple[float | None, float | None, str | None]:
    """Returns (lat, lon, problem). Frame coordinates win over place coordinates."""
    for la, lo in (("frame_latitude", "frame_longitude"), ("place_latitude", "place_longitude")):
        lat, lon = fnum(r.get(la, "")), fnum(r.get(lo, ""))
        if lat is not None and lon is not None:
            if hg.in_hawaii(lat, lon):
                return lat, lon, None
            return None, None, f"coordinates {lat},{lon} are outside Hawaii"
    return None, None, None


def import_geopath_master(conn: psycopg.Connection, path: str | Path, *, source_id: str = "jpg_master_inventory",
                          vintage: str = "Master Ad Inventory (Geopath prep) 2026-11-13", capacity_years=("2026-01-01", "2027-12-31")) -> dict:
    path = Path(path)
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    zc = hg.zcta_county()

    with import_run(conn, source_id, "inventory.geopath_master", file_name=path.name, file_sha256=sha256_file(path), source_vintage=vintage) as run, conn.cursor() as cur:
        run.bump("rows_read", len(rows))

        # ---- Pass 1: derive venue records -------------------------------------------------------
        venues: dict[str, dict] = {}
        row_venue: list[str | None] = []
        pending: list[int] = []  # rows without address: reconcile by name in pass 2
        for i, r in enumerate(rows):
            ref = f"Master Inventory!row {i + 2}"
            center = (r.get("Venue/center") or r.get("place_name") or "").strip()
            if not center:
                record_exception(cur, "venue", source_id, ref, "missing_name", "Row has no venue or place name", run.id)
                run.bump("rows_rejected")
                row_venue.append(None)
                continue
            if r.get("operator_media_name", "") not in FORMAT_MAP:
                # Reject before deriving a venue, so unknown formats never create phantom venues.
                record_exception(cur, "asset", source_id, ref, "unknown_format", f"Unmapped media name '{r.get('operator_media_name')}'", run.id)
                run.bump("rows_rejected")
                row_venue.append(None)
                continue
            addr = (r.get("place_address") or "").strip()
            lat, lon, loc_problem = _row_location(r)
            if loc_problem:
                record_exception(cur, "venue", source_id, ref, "out_of_bounds", f"{center}: {loc_problem}; coordinates discarded", run.id)
            if not addr and lat is None:
                pending.append(i)
                row_venue.append(None)
                continue
            key = slug(center) + ("--" + slug(addr) if addr else "")
            zm = ZIP_RE.search(" ".join([addr, r.get("place_zip", "")]))
            zip5 = zm.group(1) if zm else None
            v = venues.get(key)
            if v is None:
                v = venues[key] = {
                    "venue_key": key, "name": center, "venue_type": VENUE_TYPE.get(r.get("place_type", ""), "other"),
                    "operator_name": _operator(center), "address": addr or None, "city": (r.get("place_city") or "").strip() or None,
                    "zip": zip5, "lat": lat, "lon": lon, "hours_text": None, "status": "unverified", "refs": [],
                }
            if v["lat"] is None and lat is not None:
                v["lat"], v["lon"] = lat, lon
            v["refs"].append(ref)
            row_venue.append(key)

        # ---- Pass 2: reconcile rows lacking an address to an addressed venue -------------------
        cands = [{"id": k, "name": v["name"], "lat": v["lat"], "lon": v["lon"]} for k, v in venues.items()]
        for i in pending:
            r = rows[i]
            ref = f"Master Inventory!row {i + 2}"
            center = (r.get("Venue/center") or r.get("place_name")).strip()
            m = match(center, None, None, cands)
            if m["decision"] == "auto":
                row_venue[i] = m["best"]["id"]
                continue
            key = slug(center) + "--no-address"
            if key not in venues:
                venues[key] = {"venue_key": key, "name": center, "venue_type": VENUE_TYPE.get(r.get("place_type", ""), "other"),
                               "operator_name": _operator(center), "address": None, "city": None, "zip": None, "lat": None, "lon": None,
                               "hours_text": None, "status": "unverified", "refs": []}
            venues[key]["refs"].append(ref)
            row_venue[i] = key
            if m["decision"] == "review":
                record_exception(cur, "venue", source_id, ref, "ambiguous_match",
                                 f"'{center}' has no address; possible matches: " + "; ".join(f"{c['name']} ({s})" for s, c in m["ranked"][:3]), run.id)

        # Island stated in the source notes (e.g. hotel kit "Island listed in kit: Oahu") for venues without coordinates.
        stated_island: dict[str, str] = {}
        for i, r in enumerate(rows):
            m = ISLAND_NOTE_RE.search(r.get("Notes/conflicts", "") or "")
            if row_venue[i] and m:
                stated_island[row_venue[i]] = {"oahu": "Oahu", "maui": "Maui", "kauai": "Kauai", "hawaii": "Hawaii Island", "big": "Hawaii Island",
                                               "molokai": "Molokai", "lanai": "Lanai"}.get(m.group(1).lower(), None) or ""

        # ---- Write venues ----------------------------------------------------------------------
        venue_ids: dict[str, int] = {}
        for key, v in venues.items():
            county = None
            if v["lat"] is not None:
                b = hg.nearest_block(v["lat"], v["lon"])
                county = b.county if b else None
                v["location_quality"] = "source_coordinates"
            else:
                v["location_quality"] = "missing"
                county = zc.get(v["zip"]) if v["zip"] else None
                record_exception(cur, "venue", source_id, v["refs"][0], "no_coordinates",
                                 f"{v['name']}: no coordinates in source" + (f"; address '{v['address']}' can be geocoded" if v["address"] else "; no address either"), run.id)
            v["island"] = hg.island_for(county, v["lat"], v["lon"])
            if v["island"] is None:
                v["island"] = stated_island.get(key) or _island_from_name(v["name"])
            venue_ids[key] = upsert_venue(cur, v, run, source_id)

        # ---- Assets ----------------------------------------------------------------------------
        ordinal: dict[tuple, int] = defaultdict(int)
        seen_keys: dict[str, str] = {}
        for i, r in enumerate(rows):
            vkey = row_venue[i]
            if vkey is None:
                continue
            fmt = FORMAT_MAP.get(r.get("operator_media_name", ""))
            ref = f"Master Inventory!row {i + 2}"
            if not fmt:
                record_exception(cur, "asset", source_id, ref, "unknown_format", f"Unmapped media name '{r.get('operator_media_name')}'", run.id)
                run.bump("rows_rejected")
                continue
            frame_id = (r.get("operator_frame_id") or "").strip()
            placement = (r.get("placement_type") or "").strip()
            if frame_id:
                akey = "frame:" + slug(frame_id)
            else:
                desc = r.get("frame_description (shown internally)", "") or r.get("Ad ID as used by JPG", "")
                base = (vkey, fmt, placement, normalize_name(desc))
                ordinal[base] += 1  # identical rows at one venue = multiple identical units (e.g. 8 pump tops)
                akey = f"{vkey}:{fmt}:{slug(placement)}:{hashlib.sha1(normalize_name(desc).encode()).hexdigest()[:10]}:{ordinal[base]}"
            if akey in seen_keys:
                record_exception(cur, "asset", source_id, ref, "duplicate",
                                 f"Asset key '{akey}' already defined by {seen_keys[akey]}; this row was not imported.", run.id)
                run.bump("rows_rejected")
                continue
            seen_keys[akey] = ref
            notes = " ".join([r.get("Notes", ""), r.get("Notes/conflicts", "")]).lower()
            status = "operating" if r.get("frame_status") == "Operating" else "case_by_case" if "case by case" in notes else "unverified"
            rate_text = (r.get("Rate/price if listed") or "").strip() or None
            a = {
                "asset_key": akey, "venue_id": venue_ids[vkey], "format_code": fmt, "operator_frame_id": frame_id or None,
                "name": (r.get("Ad ID as used by JPG") or r.get("operator_frame_id") or r.get("place_name") or "").strip() or f"{fmt} at {vkey}",
                "placement": placement or None, "is_digital": fmt in DIGITAL_FORMATS,
                "width_in": fnum(r.get("face_width_inches") or r.get("width_inches", "")),
                "height_in": fnum(r.get("face_height_inches") or r.get("height_inches", "")),
                "pixel_width": _int(r.get("pixel_width")), "pixel_height": _int(r.get("pixel_height")),
                "orientation": (r.get("orientation") or "").strip() or None,
                "spot_length_s": fnum(r.get("average_spot_length", "")), "loop_length_s": None, "slots_per_loop": None,
                "faces": 1, "status": status, "rate_text": rate_text, "rate_4wk_usd": parse_rate(rate_text or ""),
                "rate_source": "master inventory sheet" if rate_text else None, "source_record_ref": ref,
                "attributes": {k: r[k] for k in ("place_type", "operator_media_name", "illumination", "Source sheet(s)") if r.get(k)},
            }
            rooms = ROOMS_RE.search(r.get("frame_description (shown internally)", ""))
            if rooms:  # venue-published room count from the hotel media kit
                a["attributes"]["kit_rooms"] = int(rooms.group(1).replace(",", ""))
            aid = upsert_asset(cur, a, run, source_id)
            if not a["is_digital"] and status != "case_by_case":
                ensure_static_capacity(cur, aid, 1, source_id, *capacity_years)
            if a["is_digital"]:
                record_exception(cur, "asset", source_id, ref, "missing_loop_spec",
                                 f"{a['name']}: loop length and sellable slots per loop are not in the source; occupancy and scheduled plays unavailable until supplied.", run.id)
        run.log(f"{len(venues)} venues derived from {len(rows)} rows")
    return {"run_id": run.id, **run.counts, "venues": len(venues)}


def _int(s) -> int | None:
    v = fnum(s or "")
    return int(v) if v is not None else None


def _operator(name: str) -> str | None:
    n = normalize_name(name)
    for key, label in (("aloha island mart", "Aloha Island Mart"), ("hele", "Hele"), ("mahalo", "Mahalo"), ("times", "Times Supermarkets"),
                       ("don quijote", "Don Quijote"), ("shell", "Shell"), ("aloha", "Aloha Petroleum")):
        if re.search(rf"\b{key}\b", n):
            return label
    return None


def _island_from_name(name: str) -> str | None:
    n = normalize_name(name)
    for key, isl in (("oahu", "Oahu"), ("maui", "Maui"), ("kauai", "Kauai"), ("big island", "Hawaii Island"), ("kona", "Hawaii Island"), ("hilo", "Hawaii Island")):
        if key in n:
            return isl
    return None
