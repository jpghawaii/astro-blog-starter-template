"""CLI: python -m ingest <command> [args]

Commands
  import-inventory <csv>          Geopath-format master inventory export
  import-template <kind> <csv>    JPG CSV template (venues, assets, capacity, bookings, proof_of_play, conversions,
                                  venue_counts, invoice_lines, traffic_counts)
  import-provider <provider> <file>  Licensed commercial export (placer, reveal_mobile, azira, mastercard, apollo, audiencelab, vistar, hivestack)
  geocode                          Geocode venues lacking coordinates (Nominatim, 1 req/s)
  enrich-lodes [year]              LODES8 jobs within 400/800/1600 m of each venue
  enrich-hpms                      HDOT HPMS nearest-road AADT for each venue
  enrich-acs                       ACS 5-year tract profile for each venue (needs CENSUS_API_KEY)
  enrich-osm                       OpenStreetMap POIs near venues (Overpass)
  sync-monday                      Read monday.com sales board (needs MONDAY_API_TOKEN)
  quality                          Run data-quality checks
  connection-status                Test every connector and update source_dataset.connection_status
  load-demo                        Load clearly-labelled synthetic demo data (refuses unless ALLOW_DEMO_DATA=1)
"""
from __future__ import annotations

import json
import sys

from .db import connect


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, args = argv[0], argv[1:]
    conn = connect()
    if cmd == "import-inventory":
        from .adapters.inventory import import_geopath_master
        out = import_geopath_master(conn, args[0])
    elif cmd == "import-template":
        from .adapters.templates import import_template
        out = import_template(conn, args[0], args[1])
    elif cmd == "import-provider":
        from .commercial.providers import import_provider_file
        out = import_provider_file(conn, args[0], args[1])
    elif cmd == "geocode":
        from .connectors.geocode import geocode_missing
        out = geocode_missing(conn)
    elif cmd == "enrich-lodes":
        from .connectors.lodes import enrich_venues
        out = enrich_venues(conn, int(args[0]) if args else None)
    elif cmd == "enrich-hpms":
        from .connectors.hpms import enrich_venues
        out = enrich_venues(conn)
    elif cmd == "enrich-acs":
        from .connectors.acs import enrich_venues
        out = enrich_venues(conn)
    elif cmd == "enrich-osm":
        from .connectors.osm import enrich_venues
        out = enrich_venues(conn)
    elif cmd == "sync-monday":
        from .internal.monday import sync_sales_board
        out = sync_sales_board(conn)
    elif cmd == "quality":
        from .quality import run_checks
        out = run_checks(conn)
    elif cmd == "connection-status":
        from .status import check_all
        out = check_all(conn)
    elif cmd == "load-demo":
        from .demo import load_demo
        out = load_demo(conn)
    else:
        print(f"unknown command {cmd}\n{__doc__}")
        return 2
    print(json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
