# Remaining credentials, subscriptions and data (precise list)

Put secrets in `.env.local` (never committed). Nothing below is required for the platform to run;
each item unlocks a specific capability.

## Free / quick
| # | Item | Where to get it | Env var | Unlocks |
|---|---|---|---|---|
| 1 | Census API key (free) | https://api.census.gov/data/key_signup.html | `CENSUS_API_KEY` | `python -m ingest enrich-acs` — resident tract profiles with margins of error |
| 2 | monday.com personal API token (read) | monday → avatar → Developers → My access tokens | `MONDAY_API_TOKEN` | live `sync-monday` (snapshot already imported) |
| 3 | Google service account with *Viewer* on the Master Inventory sheet | Google Cloud console → service account JSON; share the sheet with its email | `GOOGLE_APPLICATION_CREDENTIALS`, `MASTER_INVENTORY_SHEET_ID` | scheduled inventory refresh (today: CSV export) |
| 4 | Intuit developer app (QuickBooks Online, Accounting scope, read use only) | developer.intuit.com → create app → OAuth playground for refresh token | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REFRESH_TOKEN`, `QBO_REALM_ID` | live invoice sync (snapshot already imported) |
| 5 | Network access to Overpass API from the deployment host | allow `overpass-api.de` | — | nearby-business (POI) enrichment |

## Business data JPG needs to supply (highest impact first)
1. **Loop schedules** per digital screen: loop length (s) and sellable slots per loop → enables scheduled plays, occupancy and ad contacts (195 screens flagged `missing_loop_spec`).
2. **Proof-of-play exports** from EngagePHD/PingHD (or whichever CMS) per campaign → verified plays.
3. **Bookings** (campaign, asset, dates, slots, rate) from monday.com or contracts → occupancy and revenue reconciliation per campaign.
4. **Venue counts** per venue and period: register/fueling transactions, door counts, operating hours, fueling positions, lane share — with a written OK to use them in advertiser reports.
5. **Site surveys** for walls/pillars: which road each face is visible from (`faces_road`), pedestrian counts.
6. **Addresses/coordinates** for 65 venues still without a location (hotels, Kailua Town, Windward Mall, fleet).
7. GPS route logs for vans/trucks if vehicle exposure is to be estimated.

## Paid / contract (decision required)
| Provider | Why | What to ask for in the contract | Env var |
|---|---|---|---|
| Placer.ai **or** Azira | Measured venue visits & unique visitors → replaces venue-count gaps; reach across venue sets | Right to show aggregated figures in advertiser reports; export of visits/unique visitors per JPG venue; methodology doc | `PLACER_API_KEY` / `AZIRA_API_KEY` |
| Reveal Mobile | Footfall attribution studies with control groups | Study-level aggregate exports; client-report rights | `REVEAL_MOBILE_API_KEY` |
| Mastercard | Category spend trends by geography for sales narratives | Aggregated indices; internal vs client-report use | — (file delivery) |
| Apollo.io | Authorized contacts for prospects | Export rights; CRM sync; client-facing use not needed | `APOLLO_API_KEY` |
| AudienceLab | Only if activation through approved destinations is planned | Aggregated segment counts; privacy review; destination list | `AUDIENCELAB_API_KEY` |
| Vistar / Hivestack | If programmatic DOOH is sold through them | Campaign delivery report exports | — |

## License registry updates needed after each contract
Edit `source_dataset` permission columns (`permits_client_reports`, `permits_audience_activation`,
`permits_redistribution`) for the provider. Until then the platform blocks those uses.
Also confirm: DBEDT/STR hotel occupancy client-report use; each venue's permission to publish its counts.
