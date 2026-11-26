# JPG Media Analytics

Inventory, audience measurement, advertiser targeting and campaign-outcome platform for JPG Media's
Hawaii out-of-home (OOH) and digital out-of-home (DOOH) network.

Design goal: **any number on a dashboard or advertiser report can be traced to its source, period,
formula and assumptions**, and nothing is shown that the data or its license does not support.

* Methodology: [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)
* Implementation plan & source-access matrix: [`docs/SOURCE_ACCESS_MATRIX.md`](docs/SOURCE_ACCESS_MATRIX.md)
* Provider research notes: [`docs/research/provider-research.md`](docs/research/provider-research.md)
* Remaining credentials / data: [`docs/CREDENTIALS_NEEDED.md`](docs/CREDENTIALS_NEEDED.md)
* Example reports (synthetic demo data): [`docs/examples/`](docs/examples)
* Resume-work status: [`STATUS.md`](STATUS.md)

## Stack
* **Next.js 16 + TypeScript** web app (server components; no client-side DB access).
* **PostgreSQL 16 + PostGIS 3.4** (`db/migrations/*.sql`).
* **Python 3.13** ingestion & enrichment jobs (`ingest/`): retries with backoff, per-host rate limits, import-run logs, idempotent upserts.
* Leaflet map with OpenStreetMap tiles. Measurement logic in pure TypeScript (`lib/measurement`) with unit tests.

The repository root is an unrelated Astro blog; the platform lives entirely in `platform/` so the blog is untouched.

## Launch (local)

```bash
cd platform
# 1. Database (PostgreSQL 16 with PostGIS)
sudo apt-get install -y postgresql-16 postgresql-16-postgis-3
sudo -u postgres psql -c "CREATE ROLE jpg LOGIN PASSWORD 'change-me'"
sudo -u postgres createdb -O jpg jpg_analytics
sudo -u postgres createdb -O jpg jpg_analytics_test
sudo -u postgres psql -d jpg_analytics -c "CREATE EXTENSION postgis"     # superuser-only step
sudo -u postgres psql -d jpg_analytics_test -c "CREATE EXTENSION postgis"

# 2. Config
cp .env.example .env.local        # fill DATABASE_URL, TEST_DATABASE_URL, SESSION_SECRET (openssl rand -hex 32)

# 3. Install & migrate
npm ci
pip install "psycopg[binary]" requests openpyxl pytest
npm run db:migrate && npm run db:migrate -- --test

# 4. First user (password via env var, 12+ chars)
NEW_USER_PASSWORD='...' npm run db:create-user -- you@jpghawaii.com admin "Your Name"

# 5. Vertical slice: inventory -> geocode -> public data -> quality checks
python -m ingest import-inventory data/private/master_inventory_geopath_2026-11.csv   # CSV export of the Master Inventory sheet
python -m ingest geocode          # Nominatim, 1 req/s, only venues without coordinates
python -m ingest load-road-segments   # all HDOT HPMS segments (vehicle routes)
python -m ingest refresh-public   # geography, LODES jobs, HPMS AADT, ACS residents, DBEDT visitors + hotels, BLS QCEW, Census ZBP
python -m ingest quality
python -m ingest connection-status

# 6. Run
npm run build && npm start        # http://localhost:3000
```

### Demo sandbox (isolated)
Demo data only loads into a database whose name contains `demo`, `sandbox` or `test`, only with
`ALLOW_DEMO_DATA=1`, and every row is `is_demo = true` and named “DEMO …”. The app shows demo rows only when
`ALLOW_DEMO_DATA=1` and labels every page and report.
```bash
sudo -u postgres createdb -O jpg jpg_analytics_demo   # + CREATE EXTENSION postgis
DATABASE_URL=postgres://.../jpg_analytics_demo npm run db:migrate
ALLOW_DEMO_DATA=1 DATABASE_URL=postgres://.../jpg_analytics_demo python -m ingest load-demo
ALLOW_DEMO_DATA=1 DATABASE_URL=postgres://.../jpg_analytics_demo npm start
```

## Tests
```bash
npm test                          # 42 TS tests: measurement models, occupancy, licensing, outcomes, reconciliation, targeting
python -m pytest ingest/tests -q  # 18 Python tests against TEST_DATABASE_URL: geo joins, idempotency, validation, PII rejection,
                                  #   ACS MOE, DBEDT parsing, QCEW suppression, GPS route exposure, demo guard
npm run typecheck
```

## Data import
CSV templates (header + one example row) are in `templates/`:
`venues, assets, capacity, campaigns, bookings, proof_of_play, conversions, venue_counts, invoice_lines, traffic_counts`,
plus `vehicle_gps.csv` (`python -m ingest import-gps <file>` then `route-exposure <asset_id> <from> <to>`).
```bash
python -m ingest import-template bookings path/to/bookings.csv
python -m ingest import-provider placer path/to/placer_export.csv    # map vendor export to the standard provider layout first
```
Invalid rows are rejected into the **Exceptions** queue with a reason; re-importing a file is a no-op.

## Modules (web)
| Page | Purpose |
|---|---|
| Overview | inventory counts by format × island, import history, exceptions |
| Map | venues by format; geocoded locations marked |
| Venues / venue profile | assets, public-data context, per-asset estimates or the exact missing inputs, record venue counts with evidence |
| Availability | occupancy by format and date range in explicit capacity units |
| Advertisers | explainable recommendations from CRM + QuickBooks + context; authorized contacts only |
| Campaigns | delivery (verified vs scheduled plays), exposure, observed / attributed / incremental outcomes, revenue reconciliation |
| Reports | venue media sheet, audience profile, network overview, campaign proposal, delivery & outcome — client version by default, print to PDF |
| Exceptions | uncertain matches, missing coordinates, conflicts, invalid rows — resolve/link/ignore with audit trail |
| Sources | source & license registry with tested connection status |
| Methodology | metric definitions and assumptions register |

## Security & data handling
* Session auth (bcrypt, httpOnly cookie, hashed tokens) and roles: `admin`, `analyst` (restricted sources,
  revenue, exception resolution), `sales` (contacts, client reports), `viewer`.
* Credentials only server-side via env vars; `.env*` and `data/private/` are git-ignored. **This repository
  is public**: never commit real business data.
* QuickBooks and monday.com are read-only (no mutations exist in the adapters).
* Commercial person/device-level files are rejected; only aggregates are stored.
* Exports and logins are written to `audit_log`.
