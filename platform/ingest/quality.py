"""Post-import data-quality checks. Findings go to the exceptions queue (never silently fixed)."""
from __future__ import annotations

import psycopg

from .db import record_exception


def run_checks(conn: psycopg.Connection) -> dict:
    found = {}
    with conn.cursor() as cur:
        # 1. Same normalized name at different places (> 2 km): mislabelled row or wrong address.
        cur.execute("""SELECT a.id, a.name, a.address, b.id, b.address, round(ST_Distance(a.location, b.location))
                       FROM venue a JOIN venue b ON a.id < b.id
                        AND lower(regexp_replace(a.name,'[^a-zA-Z0-9]','','g')) = lower(regexp_replace(b.name,'[^a-zA-Z0-9]','','g'))
                       WHERE a.location IS NOT NULL AND b.location IS NOT NULL AND ST_Distance(a.location, b.location) > 2000
                         AND a.is_demo = false AND b.is_demo = false""")
        rows = cur.fetchall()
        for a, name, addr_a, b, addr_b, dist in rows:
            record_exception(cur, "venue", "jpg_master_inventory", f"venue:{a}+venue:{b}", "conflict",
                             f"'{name}' appears at two places {dist:.0f} m apart: '{addr_a}' (venue {a}) and '{addr_b}' (venue {b}). One row is likely mislabelled.",
                             None, [a, b])
        found["same_name_far_apart"] = len(rows)
        # 2. Venues still without any location.
        cur.execute("SELECT count(*) FROM venue WHERE location IS NULL AND is_demo=false")
        found["venues_without_location"] = cur.fetchone()[0]
        # 3. Assets missing a parsed rate (rate_text present but not a per-unit 4-week price).
        cur.execute("SELECT count(*) FROM asset WHERE rate_text IS NOT NULL AND rate_4wk_usd IS NULL AND is_demo=false")
        found["assets_with_unparsed_package_rates"] = cur.fetchone()[0]
        # 4. Metric observations older than 2 years.
        cur.execute("""UPDATE metric_observation SET quality_flags = array_append(quality_flags,'stale')
                       WHERE period_end < now() - interval '2 years' AND NOT ('stale' = ANY(quality_flags)) RETURNING id""")
        found["newly_stale_observations"] = cur.rowcount
    conn.commit()
    return found
