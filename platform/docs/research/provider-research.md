# Data Provider Research: Hawaii OOH/DOOH Analytics Platform

Checked: **2026-11-26** (all entries unless noted).

## How each fact was checked

This session's network allowlist set how much could be checked. Every fact carries one of these tags:

| Tag | Meaning |
|---|---|
| **[VERIFIED-LIVE]** | I fetched the official URL or file myself on 2026-11-26 (curl) and read the content. |
| **[SEARCH-SNIPPET]** | Seen only in a web-search index excerpt of the cited official URL. I could not open the page because this session's network policy blocked the host. Re-check before relying on it. |
| **[UNVERIFIED]** | No official source confirmed it. |

Hosts that were **blocked** (DNS or proxy refusal) and therefore not fetched directly: docs.apollo.io, apollo.io, developer.mastercard.com, mastercard.com, revealmobile.com, azira.com, placer.ai, docs.placer.ai, audiencelab.io, docs.audiencelab.io, hidot.hawaii.gov, airports.hawaii.gov, www.honolulu.gov, data.honolulu.gov, thebus.org, geodata.hawaii.gov, planning.hawaii.gov, www.census.gov, wiki.openstreetmap.org, osmfoundation.org, overpass-api.de, www.arcgis.com.
Hosts that were **reachable**: api.census.gov, www2.census.gov, lehd.ces.census.gov, tigerweb.geo.census.gov, geoportal.hawaii.gov (Hub search API), files.hawaii.gov, dbedt.hawaii.gov.

Because of this, **every commercial-provider fact in Part A is at best [SEARCH-SNIPPET]**. Do not treat any of them as contract-grade. Usage rights for every vendor need **contract review**.

---

# PART A: Commercial providers

These providers are **not interchangeable**. Each sells a different kind of data: B2B contacts, card-spend aggregates, or mobile-location panels. None is assumed to supply another's data.

## A1. Apollo.io: B2B contact and company data

| Item | Finding | Source / status |
|---|---|---|
| Relevance to OOH | B2B people and company database (contacts, enrichment, sales engagement). It has **no foot traffic, visitation, or spend data**. Use it for sales prospecting of advertisers, not for audience measurement. | [SEARCH-SNIPPET] https://www.apollo.io/developers |
| Public REST API | Base URL `https://api.apollo.io/api/v1`, given in the official OpenAPI spec. | [SEARCH-SNIPPET] https://docs.apollo.io/reference/openapi-specification |
| Auth | API key in the `x-api-key` header. Keys can be scoped. A "master key" toggle is required for some endpoints, which otherwise return 403. | [SEARCH-SNIPPET] https://docs.apollo.io/reference/authentication ; https://docs.apollo.io/docs/create-api-key |
| Endpoints seen in docs | `POST /mixed_people/api_search` (people search), `/people/match`, `/people/bulk_match` (enrichment), `/auth/health`. I did not see the organization-enrichment path. | [SEARCH-SNIPPET] https://www.apollo.io/developers ; https://docs.apollo.io/reference/people-api-search |
| Fields | Person and organization firmographic fields (name, title, company, email, phone, domain). I could not read the full schema. | [UNVERIFIED] |
| Rate limits and credits | Plan-dependent per-minute, per-hour, and per-day limits. Calls consume credits. `View API usage stats` endpoint exists. | [SEARCH-SNIPPET] https://docs.apollo.io/reference/rate-limits |
| Bulk / integrations | CRM integrations exist. I did not verify Snowflake or LiveRamp. | [UNVERIFIED] |
| Coverage | Global B2B. Hawaii businesses are presumably included, but I could not quantify this. | [UNVERIFIED] |
| License | API terms at https://www.apollo.io/terms/api. Access depends on plan and Order Form. An Apollo article says resale or embedding data in a customer-facing product needs a separate agreement. | [SEARCH-SNIPPET]. **Requires contract review** before showing Apollo data in client reports or redistributing it. |
| Self-serve? | **Yes, in part.** API keys are created in-app (Settings, Integrations, API). Endpoint access depends on plan, and free plans have very low limits. | [SEARCH-SNIPPET] https://docs.apollo.io/docs/create-api-key |

## A2. Mastercard: aggregated spend (SpendingPulse, GeoInsights, Audiences, Places)

| Item | Finding | Source / status |
|---|---|---|
| Products relevant to OOH | **SpendingPulse**: near-real-time retail sales estimates from anonymized aggregate network activity plus modeling. **GeoInsights**: area-level spend and "footfall" heatmaps. **Mastercard Audiences**: spend-based segments. **Places API / Location Services API**: merchant POI lookups. | [SEARCH-SNIPPET] https://www.mastercard.com/us/en/business/insights-intelligence/economic-market-insights/solutions/spendingpulse/spendingpulse-platform.html ; https://www.mastercard.com/global/en/business/insights-intelligence/economic-market-insights/solutions/geoinsights.html |
| "Retail Location Insights" | **Not found** as a current public product page. A Maven Central directory lists a `retail-location-insights` SDK package, but its scope is unknown. | [UNVERIFIED] |
| SpendingPulse geography and cadence | Segmentable by country, state, metro, and county (varies by country). Weekly updates with about 5 to 7 days lag. History from 2018. An AWS Marketplace listing claims US coverage of 50 states plus DC, 210 DMAs, and 3,000+ counties; geographies failing Mastercard privacy controls are suppressed. | [SEARCH-SNIPPET] Mastercard US SpendingPulse page (above) ; https://aws.amazon.com/marketplace/pp/prodview-q27tc3dgqlhew |
| Hawaii | Presumably included as a state under "50 states + DC". I did not verify county or DMA (Honolulu) availability. Small-geography suppression is likely for Neighbor Island counties. | [UNVERIFIED] for HI specifically |
| Public REST API | **Places API**: sandbox base `sandbox.api.mastercard.com/location-intelligence/places-locator/`. **Location Services**: `api.mastercard.com/locations/merchants`. I found **no public API reference for SpendingPulse**. | [SEARCH-SNIPPET] https://developer.mastercard.com/places/documentation/ ; https://developer.mastercard.com/locations-merchants/documentation/ |
| Auth | Mastercard Developers APIs generally use OAuth 1.0a request signing with a P12 signing key. I confirmed this explicitly only for ATM Locations. | [SEARCH-SNIPPET]; per-product auth [UNVERIFIED] |
| Bulk delivery | SpendingPulse and Audiences are sold via AWS Marketplace (third-party / Mastercard listings). A UK G-Cloud GeoInsights listing cites delivery by email, API, or SFTP at about £35k per year. I did not find a Snowflake Marketplace listing. | [SEARCH-SNIPPET] |
| License | The AWS SpendingPulse listing says data is for **internal business use** and must not be **redistributed without Mastercard consent**. | [SEARCH-SNIPPET]. **Requires contract review** for client reports or activation. |
| Self-serve? | Places API has a free 28-day, 10,000-call trial. SpendingPulse, GeoInsights, and Audiences are demo or sales-led. | [SEARCH-SNIPPET] |

## A3. Reveal Mobile: foot-traffic attribution and OOH measurement

| Item | Finding | Source / status |
|---|---|---|
| Products | **VISIT Local**: foot-traffic attribution, location analytics, and audience building from visit frequency. **VISIT Match**: location data feed for enriching audience and sales data. **VISIT Data**: custom location data for enterprise and analytics platforms. **Mira Console**: self-serve OOH attribution, acquired 2021, new version announced. Also brand-lift measurement. | [SEARCH-SNIPPET] https://revealmobile.com/?p=15576 ; https://blog.revealmobile.com/blog |
| OOH integrations | Place Exchange by Broadsign (programmatic OOH measurement), LoopMe (OOH brand lift, May 2025), Quan Media Group (Feb 2025), Intersection, and Pathformance (OOH to in-store sales, release dated 2026-06-12). I found **no confirmed Vistar or Hivestack integration**. | [SEARCH-SNIPPET] https://broadsign.com/blog/reveal-mobile-partners-with-place-exchange-by-broadsign-to-provide-programmatic-out-of-home-campaign-measurement/ ; https://revealmobile.com/blog/pathformance-and-reveal-partner-to-close-the-loop-between-ooh-advertising-and-in-store-sales-press |
| API | A GitHub repo `revealmobile/api-documentation` contains VISIT glossary material (projects, campaigns, index metrics). I did not verify a base URL or auth. | [SEARCH-SNIPPET] https://github.com/revealmobile/api-documentation ; base URL **unverified** |
| Bulk (S3 / Snowflake) | Not found. | [UNVERIFIED] |
| Fields | Visits, index values, and attributed visits (glossary-level only). | [UNVERIFIED] for schema |
| Coverage | US-focused, with some European brand-lift products. **Hawaii coverage not verified.** | [UNVERIFIED] |
| License | Not public. | **Requires contract review** |
| Self-serve? | Mira Console is described as "self-service". Data and API access appear sales-led. | [SEARCH-SNIPPET]; credentials [UNVERIFIED] |

## A4. Azira (formerly Near Intelligence): mobility, location intelligence, and audiences

| Item | Finding | Source / status |
|---|---|---|
| Products | Azira Insights: foot traffic, visitor counts, trade-area reach, visitor origins and commute paths, competitive share of visits. Online-to-offline attribution. Audiences. "Estimated Visits Core" covering 940k+ US and Canada locations. | [SEARCH-SNIPPET] https://azira.com/solutions/azira-insights ; https://azira.com/platform/overview |
| Scale | About 13 trillion location signals, 43 to 45M POIs, 44+ countries (figures vary by page). | [SEARCH-SNIPPET] https://azira.com/ ; https://azira.com/technology/data |
| API | The product page mentions a "Location Intelligence Dashboard and API". **No public base URL or auth documentation found.** | [UNVERIFIED] |
| Bulk / integrations | Not found on official pages. A Carvertise partnership exists (rideshare OOH tourism visit attribution). Vistar, Hivestack, and LiveRamp links are **not confirmed**. GapMaps resells Azira data. | [SEARCH-SNIPPET] https://ppc.land/carvertise-and-azira-link-rideshare-ads-to-verified-tourism-visits/ (trade press, not official) |
| Coverage | US included. Hawaii not specifically confirmed. | US [SEARCH-SNIPPET]; HI [UNVERIFIED] |
| License | Not public. | **Requires contract review** |
| Self-serve? | No. "Schedule a demo" at https://business.azira.com/demo. | [SEARCH-SNIPPET] |

## A5. Placer.ai: foot traffic and trade areas

| Item | Finding | Source / status |
|---|---|---|
| Products | Web analytics platform (visits, trade areas, demographics of visitors, visitor journey, loyalty, rankings, retail sales estimates). **Placer API (PAPI)**. Data feeds via Snowflake and AWS. Daily data refresh. Locations with 50 or fewer unique devices are suppressed. | [SEARCH-SNIPPET] https://placer.ai/products/api ; https://www.placer.ai/lp/foot-traffic-data |
| Public REST API | Docs at https://docs.placer.ai/reference. Third-party catalogs list base `https://papi.placer.ai` and auth by `x-api-key` header; **I did not confirm either on Placer's own pages**. OpenAPI groups listed: Loyalty, Ranking, Retail Sales, Visitor Journey, Manage POIs, POI search. | Base URL and auth [SEARCH-SNIPPET, third-party catalogs only]; treat as **unverified** |
| Credentials | Placer's FAQ says you need a **paying Placer account** and must ask your Customer Success Manager to enable the API and issue a key. | [SEARCH-SNIPPET] https://docs.placer.ai/reference/faqs-1 |
| Bulk | Snowflake and AWS data feeds (product tier). | [SEARCH-SNIPPET] https://www.placer.ai/lp/foot-traffic-data |
| Coverage | US. Hawaii is present: public Placer pages exist for Honolulu locations (City Mill, Waialae Ave; L&L Hawaiian Barbecue) and an article on Waikiki and Oahu. | [SEARCH-SNIPPET] https://placer.ai/chains/city-mill ; https://placer.ai/anchor/articles/the-lure-of-waikiki-and-beyond-the-feel-of-fifth-avenue-on-oahu |
| License | License Agreement (updated July 2022): limited, non-transferable, non-sublicensable. No disclosure to third parties, no derivative works, no bulk download or scraping. The Marketplace License Agreement limits use to "Permitted Uses" while the order is active. Trial data may not be used commercially. | [SEARCH-SNIPPET] https://www.placer.ai/placer-license-agreement ; https://www.placer.ai/placer-marketplace-license-agreement. **Requires contract review**, especially for client-facing reports. |
| Self-serve? | A free platform sign-up exists (limited). **API and feeds are sales or CSM-provisioned.** | [SEARCH-SNIPPET] |

## A6. AudienceLab (audiencelab.io): identity and audience data

| Item | Finding | Source / status |
|---|---|---|
| Products | Verified B2B and B2C identity data, behavioral signals, identity resolution, "SuperPixel" website visitor identification, enrichment, API, and Data-as-a-Service for agencies. **No foot-traffic or OOH-specific product found.** | [SEARCH-SNIPPET] https://audiencelab.io/faqs/ ; https://audiencelab.io/?p=3713 |
| API | The FAQ says the technical docs live at https://docs.audiencelab.io. **I could not retrieve any endpoint, base URL, or auth details.** | [UNVERIFIED] |
| Compliance | The FAQ claims SOC 2 compliance. | [SEARCH-SNIPPET] |
| Coverage | Presumably US consumer and business identities. Hawaii not verified. | [UNVERIFIED] |
| License | Not found. Person-level identity data carries privacy and regulatory risk (state privacy laws, CAN-SPAM, TCPA). | **Requires contract review plus legal and privacy review** |
| Self-serve? | Not determined. | [UNVERIFIED] |

### Part A summary

| Provider | Data type | Public API documented? | Auth | Bulk / integrations | US / HI coverage | License status | Self-serve |
|---|---|---|---|---|---|---|---|
| Apollo.io | B2B contacts and firmographics | Yes: `api.apollo.io/api/v1` [snippet] | `x-api-key` [snippet] | CRM integrations; others unverified | Global B2B; HI unverified | Contract review (resale or embedding needs separate agreement) | Yes (plan-limited) |
| Mastercard | Aggregated card spend; merchant POI | Places and Locations only [snippet]; SpendingPulse API not found | OAuth 1.0a (general) [snippet] | AWS Marketplace, SFTP/API (G-Cloud) [snippet] | US states, DMAs, counties [snippet]; HI unverified | Internal use; no redistribution without consent [snippet] | Places trial only; rest sales-led |
| Reveal Mobile | Foot-traffic attribution; OOH lift | Unverified | Unverified | Place Exchange, LoopMe, Pathformance [snippet] | US; HI unverified | Contract review | Mira self-serve UI; data sales-led |
| Azira | Mobility, visitation, trade areas, audiences | Mentioned; undocumented | Unverified | Unverified | 44 countries incl. US; HI unverified | Contract review | No (demo) |
| Placer.ai | Foot traffic, trade areas, visitor demographics | Yes: docs.placer.ai (base `papi.placer.ai` per third parties) | `x-api-key` (third-party) | Snowflake, AWS feeds [snippet] | US incl. Honolulu [snippet] | Restrictive: no third-party disclosure or derivatives [snippet] | Free UI tier; API via CSM |
| AudienceLab | Person-level identity and audiences | docs.audiencelab.io (not read) | Unverified | Unverified | Unverified | Contract plus privacy review | Unverified |

---

# PART B: Official public datasets for Hawaii

## B1. US Census ACS 5-year (api.census.gov)

- **API key now required: YES. [VERIFIED-LIVE]** Unkeyed requests such as `https://api.census.gov/data/2024/acs/acs5?get=NAME&for=state:15` return **HTTP 302 to `https://api.census.gov/data/missing_key.html`**. That page states: *"A valid key must be included with each data API request. If you don't have one, request an API Key here."* I saw the same for the 2023 and 2024 vintages.
- **Key signup:** https://api.census.gov/data/key_signup.html (HTTP 200). [VERIFIED-LIVE]
- **Latest ACS 5-year vintage on the API: 2024** (2020–2024 estimates). The discovery catalog https://api.census.gov/data.json (fetchable without a key) lists `c_vintage` 2024 `acs/acs5` "ACS 5-Year Detailed Tables", modified 2025-09-02, endpoint `https://api.census.gov/data/2024/acs/acs5`. `https://api.census.gov/data/2025/acs/acs5.json` returns 404. [VERIFIED-LIVE]
- Metadata endpoints (`/data/2024/acs/acs5.json`, `/variables.json`) respond 200 without a key. [VERIFIED-LIVE]
- Geography: state (15), county, tract, block group (Detailed Tables). Publisher: U.S. Census Bureau. License: US federal government work (public domain). I could not fetch the census.gov terms page (host blocked), so the license is [SEARCH-SNIPPET or common knowledge] and should be re-checked.

## B2. TIGER/Line and TIGERweb

- **TIGER/Line downloads [VERIFIED-LIVE]:** https://www2.census.gov/geo/tiger/ includes `TIGER2026/`. Hawaii (FIPS 15) files present include:
  - `https://www2.census.gov/geo/tiger/TIGER2026/TRACT/tl_2026_15_tract.zip`
  - `https://www2.census.gov/geo/tiger/TIGER2026/BG/tl_2026_15_bg.zip`
  - TIGER2025 has `TABBLOCK20/tl_2025_15_tabblock20.zip` and `ROADS/tl_2025_150{01,03,05,07,09}_roads.zip` (the five HI counties, including Kalawao 15005).
  - TIGER2026 has `TABBLOCK20/`, `ROADS/`, `ZCTA520/`, `PUMA20/`, `UAC20/` directories. I did not enumerate the HI files inside each.
- **TIGERweb REST [VERIFIED-LIVE]:** https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb (ArcGIS Server 11.5). Services include `Tracts_Blocks`, `State_County`, `Transportation`, `PUMA_TAD_TAZ_UGA_ZCTA`, `tigerWMS_Current`, `tigerWMS_ACS2026`, `tigerWMS_Census2020`, and others.
  - Example: `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query?where=STATE%3D%2715%27&returnCountOnly=true&f=json` returns `{"count":461}` (HI tracts, current layer). maxRecordCount is 100000. Copyright text: "Source: U.S. Census Bureau". Fields include GEOID, STATE, COUNTY, TRACT, CENTLAT, CENTLON, INTPTLAT, INTPTLON.
- No auth required. License: public domain (federal).

## B3. LEHD LODES (LODES8)

- **Latest year for Hawaii: 2024. [VERIFIED-LIVE]** Directory https://lehd.ces.census.gov/data/lodes/LODES8/hi/ contains `od/`, `rac/`, `wac/`, `hi_xwalk.csv.gz`, and `hi_xwalk.csv.sha256sum`. WAC, RAC, and OD files span 2002–2024. Data rows carry `createdate` 20261014.
- **File naming** (from Tech Doc 8.5):
  - WAC: `hi_wac_[SEG]_[TYPE]_[YEAR].csv.gz`, e.g. `https://lehd.ces.census.gov/data/lodes/LODES8/hi/wac/hi_wac_S000_JT00_2024.csv.gz`
  - RAC: `hi_rac_[SEG]_[TYPE]_[YEAR].csv.gz`
  - OD: `hi_od_[main|aux]_[TYPE]_[YEAR].csv.gz`
  - SEG: S000, SA01–03, SE01–03, SI01–03. TYPE: JT00 (all), JT01 (primary), JT02 (all private), JT03 (private primary), JT04 (all federal), JT05 (federal primary).
- **WAC header (verified from the actual 2024 HI file):**
  `w_geocode,C000,CA01,CA02,CA03,CE01,CE02,CE03,CNS01..CNS20,CR01,CR02,CR03,CR04,CR05,CR07,CT01,CT02,CD01..CD04,CS01,CS02,CFA01..CFA05,CFS01..CFS05,createdate`
- **RAC header:** `h_geocode,C000,CA01..CA03,CE01..CE03,CNS01..CNS20,CR01..CR05,CR07,CT01,CT02,CD01..CD04,CS01,CS02,createdate`. RAC has no CFA or CFS columns.
- **Column meanings (Tech Doc 8.5):** C000 = total number of jobs. CNS01 = NAICS 11 (Agriculture) ... CNS07 = 44-45 Retail ... CNS17 = 71 Arts/Entertainment/Recreation, CNS18 = 72 Accommodation and Food Services ... CNS20 = 92 Public Administration. CR05 = Native Hawaiian or Other Pacific Islander.
- **Crosswalk header (verified from hi_xwalk.csv.gz):**
  `tabblk2020,st,stusps,stname,cty,ctyname,trct,trctname,bgrp,bgrpname,cbsa,cbsaname,zcta,zctaname,stplc,stplcname,ctycsub,ctycsubname,stcd119,stcd119name,stsldl,stsldlname,stsldu,stslduname,stschool,stschoolname,stsecon,stseconname,trib,tribname,tsub,tsubname,stanrc,stanrcname,mil,milname,stwib,stwibname,blklatdd,blklondd,createdate`
  `blklatdd` and `blklondd` are block internal-point latitude and longitude in decimal degrees (e.g. 19.8294819, -155.1005145).
- **Geography:** 2020 census blocks. LODES 8.5 is based on 2025 TIGER/Line.
- **Technical documentation:** https://lehd.ces.census.gov/data/lodes/LODES8/LODESTechDoc8.5.pdf ("Format Version 8.5", Rev. 20261019). Earlier versions are 8.0, 8.1, 8.3, and 8.4 in the same folder. [VERIFIED-LIVE]
- The doc notes the data vintage differs from `createdate`. Data use noise infusion and disclosure-avoidance methods (see doc). License: public (Census Bureau).

## B4. Hawaii DBEDT visitor statistics and hotel occupancy

- **Publisher:** DBEDT Research and Economic Analysis Division (READ). [VERIFIED-LIVE]
- **Monthly visitor statistics page:** https://dbedt.hawaii.gov/economic/tourism/monthly-statistics/
  - Latest listed: **September 2026** (preliminary 2026 data).
  - Formats: Excel data plus PDF press release per month, e.g.
    - `https://files.hawaii.gov/dbedt/economic/tourism/monthly-highlights/Sep 2026.xlsx` (URL-encode the space as `%20`)
    - `https://files.hawaii.gov/dbedt/economic/tourism/monthly-highlights/press-release-2026-09.pdf`
  - Sheets in Sep 2026.xlsx: `HL, US Total, US West, US East, Japan, Canada, Glance, Island, Seats, Flights, Cruise`. The `Island` sheet has "ISLAND HIGHLIGHTS" by island (Oahu, Maui, Molokai, Lanai, Kauai, Hawaii Island).
  - Methodology: https://files.hawaii.gov/dbedt/economic/tourism/monthly-highlights/Overview%20of%20Visitor%20Statistics%20Data%20Collection.pdf
  - Island fact sheets (xlsx), e.g. `https://files.hawaii.gov/dbedt/economic/tourism/factsheets/Oahu-Fact-Sheet.xlsx`
- **Hotel performance (occupancy, ADR, RevPAR):** listed at https://dbedt.hawaii.gov/economic/tourism/infrastructure-reports/
  - Latest: **October 2026**: `https://files.hawaii.gov/dbedt/economic/tourism/hotel-performance/Hotel-performance-2026-10.pdf` and `.xlsx`. Monthly back through 2026-05 and earlier.
  - Source note in report: compiled from **STR, Inc.** survey of properties with 20+ rooms. Statewide plus island and region breakdowns (e.g. Kauai, Hawaii Island, Kohala Coast).
  - Re-use caveat: STR-derived figures. DBEDT publishes them publicly, but check attribution and licensing before republishing in client deliverables.
- Other: Tourism Data Warehouse page https://dbedt.hawaii.gov/economic/tourism-datawarehouse/ (I could not parse its content). Vacation rental, timeshare, visitor plant inventory, and air seat reports are on the infrastructure reports page.
- License: State of Hawaii public data. No explicit open license found on these pages. [UNVERIFIED license wording]

## B5. Hawaii DOT (HDOT) traffic counts / AADT

- **Best verified machine-readable source: HPMS road segments with AADT** (Hawaii Statewide GIS Program).
  - **ArcGIS service (MapServer layer): `https://geodata.hawaii.gov/arcgis/rest/services/Transportation/MapServer/12`**. Title: "Highway Performance Monitoring System Roads for Hawaii (HPMS)". Geoportal item id `d90ec964a6a54cb397a58a584243f3ab`, modified 2025-11-20. [VERIFIED-LIVE via geoportal.hawaii.gov Hub search API; **geodata.hawaii.gov itself was blocked in this session, so I could not query the layer endpoint directly**]
  - **Metadata PDF [VERIFIED-LIVE]:** https://files.hawaii.gov/dbedt/op/gis/data/hpms.pdf. Layer "HPMS (Highway Performance Monitoring System Roads for Hawaii – 2024)". Submitted by HDOT to FHWA June 2025. Source HDOT, September 2025. Line layer, UTM Zone 4 NAD83 HARN; geoportal exports are WGS84.
  - **Fields (from metadata PDF):** `YEAR_RECORD, ISLAND, ROUTE_ID, BMP, EMP, ROUTE_NAME, COUNTY_ID, COUNTY_ID_T, AADT` (two-direction), `AADT_SU` (single-unit truck and bus, FHWA classes 4–7), `AADT_CU` (combination truck, classes 8–13), `F_SYSTEM, F_SYSTEM_T, FACILITY_TYPE, FACILITY_TYPE_T, MAINT_OP, MAINT_OP_T, OWNERSHIP, OWNERSHIP_T, THROUGH_LANES, URBAN_ID, URBAN_ID_T, Shape_Length`.
  - Also available via the legacy download site https://planning.hawaii.gov/gis/download-gis-data-expanded/ (named in the PDF; host blocked here). Historical HPMS: https://www.fhwa.dot.gov/policyinformation/hpms.cfm.
  - License: geoportal licenseInfo says "State of Hawaii Terms of Use ... contents ... are public domain", with no warranty.
- **Related:** Traffic Analysis Zones (TAZ) - Oahu (OMPO 2022): `https://geodata.hawaii.gov/arcgis/rest/services/Transportation/MapServer/28`. Metadata: https://files.hawaii.gov/dbedt/op/gis/data/taz_oahu.pdf. [VERIFIED-LIVE via geoportal API]
- **HDOT station-level count program / AADT web map:** HDOT announced state-highway AADT on an ESRI web map in 2017 (https://hidot.hawaii.gov/highways/?p=11778) [SEARCH-SNIPPET]. **I did not find or verify any station-level count feature-service URL.** The DBEDT State Data Book tables (e.g. https://files.hawaii.gov/dbedt/economic/databook/2020-individual/18/181820.pdf) publish selected-site 24-hour volumes sourced from the HDOT HPMS database [SEARCH-SNIPPET].
- **City and County of Honolulu Traffic Monitoring Program** (Complete Streets) exists at https://www.honolulu.gov/completestreets/traffic-monitoring-program/ [SEARCH-SNIPPET]. Format and download are [UNVERIFIED].

## B6. Honolulu open data, TheBus ridership, HDOT Airports passenger stats

- **City and County of Honolulu Open Data:** https://data.honolulu.gov/ (Socrata, SODA API). Terms: https://data.honolulu.gov/terms-of-use (asks derived works to credit the source). Datasets are also harvested into https://catalog.data.gov/organization/city-of-honolulu. [SEARCH-SNIPPET; host blocked]
- **TheBus ridership:** DTS posts monthly "Fixed Route Performance" PDFs at thebus.org (e.g. `https://www.thebus.org/Performance/...Fixed Route - 02-2025 Performance.pdf`, with average weekday ridership). The DBEDT Data Book table 18.25 credits DTS Public Transit Division. [SEARCH-SNIPPET]. **No machine-readable API verified.** The FTA National Transit Database is an alternative federal source [UNVERIFIED for this research].
- **HDOT Airports passenger statistics:** HDOT Airports Division statistics page https://hidot.hawaii.gov/airports/?p=4842 (15 state airports, compiled from carrier, district, and FAA tower reports). Monthly PDFs, e.g. `https://hidot.hawaii.gov/airports/files/2026/02/DOT-Air-Statistics-CY-2021-through-Dec-2025.pdf`. Archives go back to 1999. [SEARCH-SNIPPET; host blocked]. **Format is PDF only as far as found. Latest vintage seen: through Dec 2025.**
- Airport GIS (Statewide GIS): Airports points `https://geodata.hawaii.gov/arcgis/rest/services/Infrastructure/MapServer/13`. HDOT Airports Property Boundaries `.../ParcelsZoning/MapServer/31`. [VERIFIED-LIVE via geoportal API]

## B7. Hawaii Statewide GIS Program: venue-related layers

All discovered via https://geoportal.hawaii.gov Hub search API (`/api/search/v1/collections/dataset/items?q=...`), owner `HawaiiStateGIS`. All point to `https://geodata.hawaii.gov/arcgis/rest/services/...`. [VERIFIED-LIVE metadata; endpoints not directly queried because geodata.hawaii.gov was blocked]

| Layer | Service URL | Modified |
|---|---|---|
| Parcels - Hawaii Statewide | `.../ParcelsZoning/MapServer/25` | 2026-09-21 |
| Parcels - Honolulu County (Oahu) | `.../ParcelsZoning/MapServer/11` | 2026-08-18 |
| Parcels - Hawaii County | `.../ParcelsZoning/MapServer/5` | 2026-06-02 |
| Parcels - Maui County | `.../ParcelsZoning/MapServer/30` | 2026-06-02 |
| Parcels - County of Kauai | `.../ParcelsZoning/MapServer/9` | 2026-06-03 |
| Parcels - TMK Zone / Section / Plat | `.../ParcelsZoning/MapServer/27`, `/28`, `/26` | 2021 |
| Zoning (City and County of Honolulu) | `.../ParcelsZoning/MapServer/3` | 2024-09-05 |
| Zoning (Hawaii County) | `.../ParcelsZoning/MapServer/2` | 2026-06-16 |
| Zoning (County of Maui) | `.../ParcelsZoning/MapServer/33` | 2025-09-06 |
| Zoning (County of Kauai) | `.../ParcelsZoning/MapServer/29` | 2026-06-16 |
| State Land Use Districts | `.../ParcelsZoning/MapServer/20` | 2024-09-05 |
| Land Use Land Cover (LULC) | `.../LandUseLandCover/MapServer/11` | 2024-06-01 |
| Opportunity / Enterprise Zones | `.../BusinessEconomy/MapServer/6`, `/5`, `/4` | 2026 |

License (geoportal licenseInfo): State of Hawaii Terms of Use; content public domain; no warranty. Contact: gis@hawaii.gov.

## B8. OpenStreetMap: Overpass API and ODbL

- **Overpass usage policy:** The OSM wiki's public-instance table gives the main instance (overpass-api.de) policy as **about 10,000 queries per day and under 1 GB per day**. It recommends self-hosting for regular use. The Overpass manual ("commons" page) says rate limiting is per IP and denied requests get **HTTP 429**; default timeout is 180 s and default memory is 512 MiB. Sources: https://wiki.openstreetmap.org/wiki/Overpass_API ; https://dev.overpass-api.de/overpass-doc/en/preface/commons.html. [SEARCH-SNIPPET; hosts blocked]. For a production platform, **self-host Overpass or use Geofabrik extracts** rather than the public instance.
- **ODbL obligations** (OSMF Attribution Guidelines, adopted 2021-06-25; Licence and Legal FAQ):
  - Attribution: credit "© OpenStreetMap contributors" with a link to the ODbL or copyright page, visible where people see the work (maps, visualisations, reports).
  - **Derivative database** (e.g. our venue table merged with OSM POIs): if **publicly used**, it must be offered under ODbL (share-alike) or the changes released. Internal-only use triggers no share-alike.
  - **Produced work** (map image, chart, PDF report): may carry its own license, but needs attribution. On request you must supply the underlying derivative database. A produced work used to extract substantial OSM data is treated as a database.
  - Sources: https://osmfoundation.org/wiki/Licence/Attribution_Guidelines ; https://osmfoundation.org/wiki/Licence_and_Legal_FAQ ; https://opendatacommons.org/licenses/odbl/1-0/. [SEARCH-SNIPPET]
  - Platform implication: keep OSM-derived tables **separable** from proprietary vendor data (Placer, Mastercard, etc.). Mixing them into one publicly used database may create share-alike conflicts with vendor licenses.

### Part B summary

| Dataset | Access | Auth | HI coverage / resolution | Latest vintage | License |
|---|---|---|---|---|---|
| ACS 5-yr | api.census.gov REST | **API key required** (verified) | State to block group | **2024** (2020–24) | Public domain (federal) |
| TIGER/Line | www2.census.gov zip | None | Block / BG / tract / roads | **TIGER2026** | Public domain |
| TIGERweb | ArcGIS REST | None | Same; HI tracts = 461 | Current / ACS2026 | Public domain |
| LODES8 | lehd.ces.census.gov csv.gz | None | 2020 blocks | **2024** (Tech Doc 8.5) | Public |
| DBEDT visitors | xlsx / pdf downloads | None | State + island | **Sep 2026** | State public (wording unverified) |
| DBEDT hotel perf. | xlsx / pdf | None | State, island, region | **Oct 2026** | STR-sourced; check before republishing |
| HDOT HPMS AADT | ArcGIS `Transportation/MapServer/12` + PDF metadata | None | Road segments, all islands | **2024 data** (pub. Sep 2025) | Public domain (State ToU) |
| HDOT station counts | Not found | n/a | n/a | n/a | **Unverified** |
| Honolulu open data | Socrata SODA | Optional app token | Oahu | Unverified | Attribution requested |
| TheBus ridership | Monthly PDFs | None | Oahu system | ~2025 seen | Unverified |
| HDOT Airports pax | Monthly PDFs | None | 15 airports | Through Dec 2025 seen | Unverified |
| Statewide GIS parcels / zoning | ArcGIS MapServer | None | Parcel (TMK) | Statewide parcels 2026-09 | Public domain (State ToU) |
| OSM / Overpass | Overpass API / extracts | None | Global | Live | ODbL (attribution, share-alike on public DBs) |

## Follow-ups needed

1. Allow `geodata.hawaii.gov` in the session network to query HPMS layer 12 directly (field list, record count, `?f=json`). Also allow `hidot.hawaii.gov`, `data.honolulu.gov`, `docs.placer.ai`, `docs.apollo.io`, `developer.mastercard.com`, and `docs.audiencelab.io` to upgrade [SEARCH-SNIPPET] items to verified.
2. Request from each vendor: data dictionary, Hawaii sample (Oahu and Neighbor Islands), minimum-threshold and suppression rules, and license language covering (a) internal analysis, (b) client-facing reports, (c) audience activation, (d) redistribution.
3. Confirm with HDOT Highways Planning Branch whether station-level (count-station) AADT is published as a feature service.
