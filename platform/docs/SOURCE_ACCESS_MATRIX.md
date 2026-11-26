# Implementation plan & source-access matrix

Status as of 2026-11-26. "Tested" means a live call or import succeeded in this environment.
Vendor facts marked *unverified* come from search snippets only (vendor sites were unreachable here);
see `docs/research/provider-research.md` for URLs and verification notes.

## Implementation plan (delivered in this order)

1. **Vertical slice** — import inventory → map → enrich with public data → audience profile → client report. ✅
2. **Data model & provenance** — normalized schema, metric observations with source/period/status/uses, import runs, exceptions queue. ✅
3. **Commercial adapters** — licensed-file adapters with person-level rejection and license gating; API status checker. ✅ (no vendor API connected: credentials/contracts missing)
4. **Advertiser recommendations** — explainable scoring from CRM + QuickBooks + context. ✅
5. **Campaign outcomes** — delivery (PoP), observed/attributed/lift tiers, revenue reconciliation. ✅ (production campaigns not yet imported)
6. **Next** — connect live tokens, import bookings & proof-of-play, survey loop specs, replace assumptions with observations.

## Public datasets

| Source | Access | Auth | Resolution / vintage | License | Status here | Used for |
|---|---|---|---|---|---|---|
| Census LEHD LODES8 (WAC + xwalk) | bulk csv.gz | none | 2020 blocks, **2024** | US Gov (public domain) | **tested, imported** (172 venues × 3 radii) | Daytime jobs near venues, island/county from blocks |
| HDOT HPMS roads (AADT) via State GIS | ArcGIS REST `geodata.hawaii.gov/.../Transportation/MapServer/12` | none | road segment, **2024** | State open data | **tested, imported** (139 venues) | Nearest-road traffic context; static faces after survey |
| DBEDT hotel performance | xlsx on files.hawaii.gov | none | island/region, monthly (**Oct 2026**) | State; STR-sourced → client use pending | **tested, imported** | Hotel occupancy → lobby visits |
| Census ACS 5-year | api.census.gov | **free key required** | tract, 2020–2024 | US Gov | adapter built + mocked tests; **needs CENSUS_API_KEY** | Resident profile (not visitors) |
| TIGERweb | ArcGIS REST | none | tract/block | US Gov | registered (crosswalk used instead) | Boundaries if needed |
| OpenStreetMap Nominatim | REST, 1 req/s | none | address | ODbL | **tested** (73 venues geocoded) | Geocoding (flagged as geocoded) |
| OpenStreetMap Overpass | REST | none | POI | ODbL | adapter built; **blocked** (connection reset from this environment) | Nearby businesses for prospecting |
| Honolulu open data, TheBus, Airports stats | portals/PDF | none | Oahu / airports | various | not integrated (PDF-only or unverified) | Future |

## Internal systems (read-only)

| Source | What was found | Access path | Status |
|---|---|---|---|
| Google Sheet “JPG Media Master Ad Inventory (Geopath prep) – Nov 2026” | 632 rows, 57 Geopath columns + source/conflict notes | CSV export → `import-inventory` | **imported** (237 venues, 632 assets); service-account sync needs `GOOGLE_APPLICATION_CREDENTIALS` |
| monday.com “JPG Media Sales” board (18 deals) | industry, inventory interest, stage, contacts | GraphQL API (read-only) or snapshot | snapshot **imported**; live sync needs `MONDAY_API_TOKEN` |
| QuickBooks Online (Media In Motion Hawaii dba JPG Media) | 129 invoices / 920 lines 2025-01 → 2026-12 | Intuit OAuth app (read) or export | snapshot **imported** + classified; live sync needs Intuit app |
| EngagePHD / PingHD CMS proof-of-play | not found in workspace | CSV template | **needed** |
| Vistar / Hivestack reports | not found | delivery-report export template | **needed** (if used) |
| GA4 | not connected | CSV export / Data API | **needed** per advertiser |
| Bookings / loop schedules | not found as structured data (contract details live in invoice memos) | bookings + capacity templates | **needed** |

## Commercial providers

| Provider | Supplies (not interchangeable) | Access | Self-serve | License (client reports / activation / redistribution) | Adapter | Status |
|---|---|---|---|---|---|---|
| Apollo.io | B2B companies & contacts only | REST (`x-api-key`, *unverified*), CSV export | yes (plan-limited) | contract review (*snippet: resale/client-facing needs agreement*) | `commercial/apollo.py` (export) | needs credentials |
| Mastercard | aggregated spend indices (SpendingPulse etc.) | licensed files / marketplace | no | contract review; internal-only per snippet | `providers.py` (mastercard) | needs subscription |
| Reveal Mobile | OOH footfall attribution studies | study exports (API *unverified*) | dashboard only | contract review | `providers.py` (reveal_mobile) | needs subscription |
| Azira (ex-Near) | visitation, trade areas, audiences | sales-led; API undocumented | no | contract review | `providers.py` (azira) | needs subscription |
| Placer.ai | venue visits, trade areas, visitor demographics | API via account manager; Snowflake/AWS feeds | no | restrictive (*snippet: no third-party sharing/derived works*) | `providers.py` (placer) | needs subscription |
| AudienceLab | person-level identity & visitor ID | contract | *unverified* | contract + privacy review | `providers.py` (aggregates only; person-level rejected) | needs subscription |

All provider values are stored as `vendor_modeled` with **no permitted use** until the source registry
is updated after contract review (unknown license = blocked).
