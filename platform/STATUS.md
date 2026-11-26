# Project status — resume here

_Last updated: 2026-11-26 (session 1, round 2: traffic, visitors, demographics, industry & business data)._

## State
* **Code**: `platform/` on branch `ccr-1744846a-4jolme`. Web app, schema (migrations 001–008), ingestion, tests, docs.
* **Tests**: 42 TS (vitest) + 18 Python (pytest) passing. `npm run build` clean.
* **Databases (local only, not in git)**: `jpg_analytics` (real data), `jpg_analytics_test` (tests truncate it), `jpg_analytics_demo` (synthetic).
* **Private data (git-ignored, `platform/data/private/`)**:
  `master_inventory_geopath_2026-11.csv` (Google Sheet export, 632 rows),
  `monday_sales_snapshot_2026-11-26.json` (18 deals), `qbo_invoice_lines_2025-2026.csv` (920 lines),
  `reports/*.pdf` (real-data report samples). Cloud containers are ephemeral: re-export if missing.
* **Network allowlist (environment "astro-blog-starter-template (JPG analytics)")** includes Census (api, www2, www, tigerweb, lehd),
  Hawaii State GIS/geoportal/opendata, DBEDT, files.hawaii.gov, HDOT (highways, hidot), Honolulu open data, BLS, HTA, OSM.

## Real data loaded (jpg_analytics)
| Item | Count / vintage |
|---|---|
| Venues / with location / geocoded | 237 / 172 / 73 |
| Assets (faces/screens) | 632 (195 digital) |
| LODES8 jobs near venues | 2024, 172 venues × 3 radii |
| HPMS nearest-road AADT | 2024, 139 venues; 2,075 road segments statewide loaded for vehicle routes |
| ACS 5-year resident profile (bulk, no key) | 2020–2024, 172 venues × 8 measures with MOE |
| DBEDT visitor statistics by island | Sep 2026 (preliminary) |
| DBEDT hotel occupancy (STR-sourced, internal) | Oct 2026, 8 regions |
| BLS QCEW county × industry | 2026 Q1 (54 suppressed cells kept unavailable) |
| Census ZIP Business Patterns | 2023, 560 ZIP × NAICS rows |
| QuickBooks invoice lines | 920 (2025-01 → 2026-12), classified; 387 linked to venues |
| Advertisers (CRM + QuickBooks) | 41 |
| Open exceptions | ~331 (195 missing loop spec, 65 no coordinates, …) |

Treat all venue/asset counts as **unverified** until reconciled with installed-player and venue-contract records.

## What public data cannot provide (needs JPG data or a license)
* Venue visits / transactions (venue partners or Placer.ai/Azira).
* Card-spend at venue or trade-area level (Mastercard license).
* Pedestrian counts at mall faces (site counts); Honolulu's open-data portal has no traffic-count datasets.
* Vehicle exposure needs GPS logs from the vans/trucks (template ready; nothing imported yet).
* HLTA hotel detail (member/STR data) and HTA partner reports: import entitled exports with their terms.

## Next steps (priority)
1. Supply loop schedules + proof-of-play exports for screens (templates/capacity.csv, proof_of_play.csv).
2. Export bookings from monday.com / contracts into templates/bookings.csv; link invoices to campaigns (`campaign_key`).
3. Export GPS logs for vans/trucks (templates/vehicle_gps.csv).
4. Resolve geocoding and hotel-address exceptions (Exceptions page).
5. Decide on one visitation provider (Placer.ai or Azira) and whether Mastercard spend data is worth licensing; update license registry after contract review.
6. Deploy: managed Postgres with PostGIS + Node host; schedule `python -m ingest refresh-public` monthly.
7. Review assumptions register with sales/ops; replace with measurements where possible.

## Commands cheat-sheet
```bash
cd platform
npm run db:migrate                # apply new migrations
python -m ingest --help           # all ingestion commands
python -m ingest refresh-public   # all public-data refreshes
python -m ingest connection-status
npm test && python -m pytest ingest/tests -q
```
