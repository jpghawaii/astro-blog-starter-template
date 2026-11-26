"""Address geocoding through the public Nominatim service, honoring its usage policy:
max 1 request/second, identifying User-Agent (generic, no personal data), results cached,
no bulk/systematic re-querying. Results are stored with location_quality='geocoded_address'
and every match is validated to lie in Hawaii; low-precision results go to the exceptions queue."""
from __future__ import annotations

import json

import psycopg
import requests

from .. import hawaii_geo as hg
from ..db import RateLimiter, import_run, record_exception, with_retries

URL = "https://nominatim.openstreetmap.org/search"
UA = "jpg-media-analytics/0.1 (internal venue geocoding)"
CACHE = hg.CACHE / "nominatim_cache.json"
_limiter = RateLimiter(1.1)
PRECISE = {"house", "building", "amenity", "shop", "fuel", "retail", "commercial", "hotel", "tourism", "mall", "supermarket", "convenience"}


def _cache() -> dict:
    return json.loads(CACHE.read_text()) if CACHE.exists() else {}


def geocode(q: str, cache: dict) -> list:
    if q in cache:
        return cache[q]

    def call():
        _limiter.wait()
        r = requests.get(URL, params={"q": q, "format": "jsonv2", "countrycodes": "us", "limit": 3, "addressdetails": 1},
                         headers={"User-Agent": UA}, timeout=30)
        r.raise_for_status()
        return r.json()

    res = with_retries(call)
    cache[q] = res
    CACHE.write_text(json.dumps(cache))
    return res


def geocode_missing(conn: psycopg.Connection, limit: int = 500) -> dict:
    cache = _cache()
    with import_run(conn, "osm", "connectors.geocode.nominatim", params={"limit": limit}) as run, conn.cursor() as cur:
        cur.execute("""SELECT id, name, address, city, zip FROM venue WHERE location IS NULL AND address IS NOT NULL
                       AND is_demo = false ORDER BY id LIMIT %s""", (limit,))
        todo = cur.fetchall()
        run.bump("rows_read", len(todo))
        for vid, name, address, city, zip5 in todo:
            q = ", ".join(x for x in [address, city if city and city not in address else None, "Hawaii" if "HI" not in address else None] if x)
            res = [r for r in geocode(q, cache) if hg.in_hawaii(float(r["lat"]), float(r["lon"]))]
            ref = f"venue:{vid}"
            if not res:
                record_exception(cur, "venue", "osm", ref, "geocode_failed", f"{name}: no Hawaii result for '{q}'", run.id)
                run.bump("rows_rejected")
                continue
            top = res[0]
            precise = top.get("type") in PRECISE or top.get("category") in PRECISE or top.get("addresstype") in ("building", "house")
            if not precise:
                record_exception(cur, "venue", "osm", ref, "geocode_low_precision",
                                 f"{name}: '{q}' matched {top.get('addresstype') or top.get('type')} '{top.get('display_name')}'; location stored but needs review", run.id)
            lat, lon = float(top["lat"]), float(top["lon"])
            b = hg.nearest_block(lat, lon)
            cur.execute("""UPDATE venue SET location = ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography, location_quality='geocoded_address',
                             island = COALESCE(island, %s), updated_at = now() WHERE id=%s AND location IS NULL""",
                        (lon, lat, hg.island_for(b.county, lat, lon) if b else None, vid))
            cur.execute("""UPDATE match_exception SET status='resolved', resolution=%s, resolved_by='geocoder', resolved_at=now()
                           WHERE entity_type='venue' AND issue='no_coordinates' AND status='open'
                             AND source_record_ref = ANY(SELECT source_record_ref FROM asset WHERE venue_id=%s)""",
                        (f"Geocoded via Nominatim ({'precise' if precise else 'low precision - review'})", vid))
            run.bump("rows_updated")
    return {"run_id": run.id, **run.counts}
