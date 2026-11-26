"""OpenStreetMap POIs near venues via the Overpass API (ODbL).

Usage policy: modest query rate (1 query / 2 s here), cached by venue. Data are ODbL: attribute
'© OpenStreetMap contributors'; OSM-derived tables (poi) are kept separate from licensed vendor data.
Used for contextual advertiser prospecting (business categories near venues), never for individuals.
"""
from __future__ import annotations

import psycopg
import requests
from psycopg.types.json import Jsonb

from ..db import RateLimiter, import_run, with_retries

ENDPOINT = "https://overpass-api.de/api/interpreter"
_limiter = RateLimiter(2.0)
RADIUS_M = 400
CATEGORIES = ("amenity", "shop", "tourism", "healthcare", "office", "leisure")


def query(lat: float, lon: float, radius=RADIUS_M) -> list[dict]:
    q = f"""[out:json][timeout:25];(
      nwr(around:{radius},{lat},{lon})["name"]["amenity"];
      nwr(around:{radius},{lat},{lon})["name"]["shop"];
      nwr(around:{radius},{lat},{lon})["name"]["tourism"];
      nwr(around:{radius},{lat},{lon})["name"]["healthcare"];
      nwr(around:{radius},{lat},{lon})["name"]["office"];
    );out center tags;"""
    def call():
        _limiter.wait()
        r = requests.post(ENDPOINT, data={"data": q}, headers={"User-Agent": "jpg-media-analytics/0.1"}, timeout=60)
        r.raise_for_status()
        return r.json()["elements"]
    return with_retries(call, attempts=3, base_delay_s=5)


def enrich_venues(conn: psycopg.Connection, limit: int = 1000) -> dict:
    with import_run(conn, "osm", "connectors.osm.pois", params={"radius_m": RADIUS_M}) as run, conn.cursor() as cur:
        cur.execute("SELECT id, ST_Y(location::geometry), ST_X(location::geometry) FROM venue WHERE location IS NOT NULL AND is_demo=false ORDER BY id LIMIT %s", (limit,))
        venues = cur.fetchall()
        run.bump("rows_read", len(venues))
        for vid, lat, lon in venues:
            for el in query(lat, lon):
                tags = el.get("tags", {})
                cat = next((k for k in CATEGORIES if k in tags), None)
                la = el.get("lat") or el.get("center", {}).get("lat")
                lo = el.get("lon") or el.get("center", {}).get("lon")
                if not cat or la is None:
                    continue
                cur.execute("""INSERT INTO poi (source_id, external_id, name, category, subcategory, location, tags, import_run_id)
                               VALUES ('osm', %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography, %s, %s)
                               ON CONFLICT (source_id, external_id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, subcategory=EXCLUDED.subcategory, tags=EXCLUDED.tags
                               WHERE (poi.name, poi.subcategory, poi.tags) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.subcategory, EXCLUDED.tags)
                               RETURNING (xmax=0)""",
                            (f"{el['type']}/{el['id']}", tags.get("name"), cat, tags.get(cat), lo, la,
                             Jsonb({k: tags[k] for k in ("brand", "cuisine", "website", "opening_hours", "addr:street", "addr:city") if k in tags}), run.id))
                row = cur.fetchone()
                run.bump("rows_unchanged" if row is None else "rows_inserted" if row[0] else "rows_updated")
            conn.commit()
    return {"run_id": run.id, **run.counts}
