"""CLI: python -m ingest <command> [args]

Commands
  import-inventory <csv>          Geopath-format master inventory export
  import-template <kind> <csv>    JPG CSV template (venues, assets, capacity, bookings, proof_of_play, conversions,
                                  venue_counts, invoice_lines, traffic_counts)
  import-provider <provider> <file>  Licensed commercial export (placer, reveal_mobile, azira, mastercard, apollo, audiencelab, vistar, hivestack)
  geocode                          Geocode venues lacking coordinates (Nominatim, 1 req/s)
  enrich-lodes [year]              LODES8 jobs within 400/800/1600 m of each venue
  enrich-hpms                      HDOT HPMS nearest-road AADT for each venue
  enrich-acs                       ACS 5-year resident tract profile per venue (bulk Summary File, no key needed)
  assign-geography                 County / tract / ZCTA / block for each located venue
  import-visitors                  DBEDT monthly visitor statistics by island (arrivals, daily census, spending)
  import-hotel-occupancy           DBEDT monthly hotel occupancy by region (STR-sourced, internal use)
  import-qcew                      BLS QCEW jobs / wages by county x industry (latest quarter)
  import-zbp [year]                Census ZIP Business Patterns establishments by ZIP x NAICS
  load-road-segments               All HDOT HPMS road segments with AADT (for vehicle routes)
  import-gps <csv>                 Vehicle GPS pings (templates/vehicle_gps.csv)
  route-exposure <asset_id> <from> <to>   Seconds per road segment for a vehicle and period
  refresh-public                   Run every public-data refresh above (schedule monthly)
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
    elif cmd == "assign-geography":
        from .hawaii_geo import assign_venue_geography
        out = assign_venue_geography(conn)
    elif cmd == "import-visitors":
        from .connectors.market import import_visitor_stats
        out = import_visitor_stats(conn)
    elif cmd == "import-hotel-occupancy":
        from .connectors.dbedt import import_hotel_occupancy
        out = import_hotel_occupancy(conn)
    elif cmd == "import-qcew":
        from .connectors.market import import_qcew
        out = import_qcew(conn)
    elif cmd == "import-zbp":
        from .connectors.market import import_zbp
        out = import_zbp(conn, int(args[0]) if args else 2023)
    elif cmd == "load-road-segments":
        from .connectors.hpms import load_segments
        out = load_segments(conn)
    elif cmd == "import-gps":
        from .adapters.gps import import_gps
        out = import_gps(conn, args[0])
    elif cmd == "route-exposure":
        from .adapters.gps import compute_route_exposure
        out = compute_route_exposure(conn, int(args[0]), args[1], args[2])
    elif cmd == "refresh-public":
        from .connectors import acs, hpms, lodes, market
        from .connectors.dbedt import import_hotel_occupancy
        from .hawaii_geo import assign_venue_geography
        out = {"geography": assign_venue_geography(conn), "lodes": lodes.enrich_venues(conn), "hpms": hpms.enrich_venues(conn),
               "acs": acs.enrich_venues(conn), "visitors": market.import_visitor_stats(conn), "hotels": import_hotel_occupancy(conn),
               "qcew": market.import_qcew(conn), "zbp": market.import_zbp(conn)}
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
