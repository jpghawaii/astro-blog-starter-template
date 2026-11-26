-- JPG Media analytics platform: core normalized schema.
-- Conventions
--   * Every row that can come from more than one place carries source_id + import_run_id.
--   * is_demo = true marks synthetic demonstration rows. Production queries filter them out
--     unless the caller explicitly opts in (see v_* views and lib/db.ts).
--   * Missing measurements are represented by ABSENT rows or NULL values, never by 0.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- Source & license registry
-- ---------------------------------------------------------------------------
CREATE TABLE source_dataset (
  id                     text PRIMARY KEY,               -- stable slug, e.g. 'census_lodes8'
  name                   text NOT NULL,
  provider               text NOT NULL,
  category               text NOT NULL CHECK (category IN ('public','commercial','internal','venue_provided','demo')),
  access_method          text NOT NULL,                  -- 'bulk_download','rest_api','csv_export','mcp_connector', ...
  documentation_url      text,
  license_name           text,
  license_url            text,
  attribution_text       text,
  permits_internal_analysis   boolean,                   -- NULL = unknown / pending contract review
  permits_client_reports      boolean,
  permits_audience_activation boolean,
  permits_redistribution      boolean,
  connection_status      text NOT NULL DEFAULT 'not_connected'
                         CHECK (connection_status IN ('tested_working','configured_untested','not_connected','needs_credentials','needs_subscription','blocked','not_applicable')),
  connection_tested_at   timestamptz,
  connection_notes       text,
  geographic_coverage    text,
  refresh_cadence        text,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_run (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  adapter         text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','partial')),
  attempt         int NOT NULL DEFAULT 1,
  file_name       text,
  file_sha256     text,
  source_vintage  text,               -- e.g. 'LODES8 2022', 'Master Inventory 2026-11-13'
  rows_read       int DEFAULT 0,
  rows_inserted   int DEFAULT 0,
  rows_updated    int DEFAULT 0,
  rows_unchanged  int DEFAULT 0,
  rows_rejected   int DEFAULT 0,
  is_demo         boolean NOT NULL DEFAULT false,
  params          jsonb NOT NULL DEFAULT '{}',
  log             text[] NOT NULL DEFAULT '{}',
  error           text
);

-- ---------------------------------------------------------------------------
-- Metric definitions (formula registry, versioned)
-- ---------------------------------------------------------------------------
CREATE TABLE metric_definition (
  code            text NOT NULL,
  version         int  NOT NULL,
  name            text NOT NULL,
  unit            text NOT NULL,
  definition      text NOT NULL,
  formula         text,
  applies_to      text[] NOT NULL DEFAULT '{}',   -- media formats or 'venue','campaign','geo_area'
  cautions        text,
  is_current      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (code, version)
);

-- Assumptions used by internal models, each with low/base/high and a rationale.
CREATE TABLE model_assumption (
  code            text NOT NULL,
  applies_to      text NOT NULL,          -- media format code or '*'
  description     text NOT NULL,
  unit            text NOT NULL,
  low_value       numeric,
  base_value      numeric,
  high_value      numeric,
  rationale       text NOT NULL,
  source_id       text REFERENCES source_dataset(id),
  status          text NOT NULL DEFAULT 'assumed' CHECK (status IN ('observed','vendor_modeled','internally_modeled','assumed')),
  reviewed_by     text,
  reviewed_at     date,
  PRIMARY KEY (code, applies_to)
);

-- ---------------------------------------------------------------------------
-- Geography
-- ---------------------------------------------------------------------------
CREATE TABLE geo_area (
  geoid           text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('state','county','tract','block_group','block','zcta','trade_area','island')),
  vintage         text NOT NULL,          -- e.g. '2020 blocks'
  name            text,
  county_fips     text,
  internal_point  geography(Point,4326),
  boundary        geography(MultiPolygon,4326),
  land_area_m2    numeric,
  source_id       text REFERENCES source_dataset(id),
  import_run_id   bigint REFERENCES import_run(id),
  PRIMARY KEY (kind, geoid, vintage)
);
CREATE INDEX geo_area_point_gix ON geo_area USING gist (internal_point);
CREATE INDEX geo_area_boundary_gix ON geo_area USING gist (boundary);

-- ---------------------------------------------------------------------------
-- Inventory: venues -> assets (physical faces/screens) -> capacity periods (sellable slots)
-- ---------------------------------------------------------------------------
CREATE TABLE media_format (
  code                text PRIMARY KEY,   -- 'cstore_screen','pump_top','checkout','hotel_screen','mall_static','mall_screen','vehicle'
  name                text NOT NULL,
  is_digital          boolean NOT NULL,
  measurement_method  text NOT NULL,      -- key into lib/measurement
  capacity_unit       text NOT NULL,      -- 'spot_slot' (digital loop share) or 'face_period' (static face x 4-week cycle)
  default_cycle_days  int NOT NULL DEFAULT 28,
  description         text
);

CREATE TABLE venue (
  id                  bigserial PRIMARY KEY,
  venue_key           text NOT NULL UNIQUE,     -- deterministic key derived from normalized name+address
  name                text NOT NULL,
  venue_type          text NOT NULL,            -- 'gas_station','grocery','hotel','shopping_center','transit_fleet', ...
  operator_name       text,                     -- e.g. 'Aloha Island Mart', 'Times Supermarkets'
  address             text,
  city                text,
  state               text DEFAULT 'HI',
  zip                 text,
  island              text,                     -- Oahu, Maui, Hawaii Island, Kauai, Molokai, Lanai
  location            geography(Point,4326),
  location_quality    text CHECK (location_quality IN ('surveyed','source_coordinates','geocoded_address','island_centroid','missing')),
  hours_text          text,
  status              text NOT NULL DEFAULT 'unverified' CHECK (status IN ('active','unverified','inactive','removed')),
  verified_at         date,
  is_demo             boolean NOT NULL DEFAULT false,
  source_id           text REFERENCES source_dataset(id),
  import_run_id       bigint REFERENCES import_run(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_location_gix ON venue USING gist (location);

-- External identifiers from every system, for reconciliation (Monday, QuickBooks, CMS, Geopath...).
CREATE TABLE venue_identifier (
  venue_id        bigint NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  system          text NOT NULL,
  external_id     text NOT NULL,
  external_name   text,
  PRIMARY KEY (system, external_id)
);

CREATE TABLE asset (
  id                  bigserial PRIMARY KEY,
  asset_key           text NOT NULL UNIQUE,       -- deterministic key; operator frame id when available
  venue_id            bigint NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  format_code         text NOT NULL REFERENCES media_format(code),
  operator_frame_id   text,
  name                text NOT NULL,
  placement           text,                        -- 'At Pump','In-Store Cooler','Checkout Area',...
  is_digital          boolean NOT NULL,
  width_in            numeric,
  height_in           numeric,
  pixel_width         int,
  pixel_height        int,
  orientation         text,
  spot_length_s       numeric,                      -- ad duration
  loop_length_s       numeric,                      -- full loop duration, NULL = unknown
  slots_per_loop      int,                          -- sellable advertiser slots per loop, NULL = unknown
  faces               int NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'unverified' CHECK (status IN ('operating','unverified','case_by_case','inactive','removed')),
  rate_text           text,                         -- verbatim rate note from source
  rate_4wk_usd        numeric,                      -- parsed list rate per 4 weeks, NULL = not parsed
  rate_source         text,
  attributes          jsonb NOT NULL DEFAULT '{}',
  is_demo             boolean NOT NULL DEFAULT false,
  source_id           text REFERENCES source_dataset(id),
  import_run_id       bigint REFERENCES import_run(id),
  source_record_ref   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_venue_idx ON asset (venue_id);

-- Sellable capacity of an asset over a date range in an explicit unit.
CREATE TABLE capacity_period (
  id              bigserial PRIMARY KEY,
  asset_id        bigint NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  period          daterange NOT NULL,
  unit            text NOT NULL CHECK (unit IN ('spot_slot','face_period')),
  capacity        numeric NOT NULL CHECK (capacity >= 0),  -- e.g. 6 slots/loop, or 1 face
  basis           text NOT NULL,                           -- how capacity was determined
  source_id       text REFERENCES source_dataset(id),
  is_demo         boolean NOT NULL DEFAULT false
);
CREATE INDEX capacity_period_asset_idx ON capacity_period (asset_id);

-- ---------------------------------------------------------------------------
-- Commercial: advertisers, campaigns, bookings, invoices
-- ---------------------------------------------------------------------------
CREATE TABLE advertiser (
  id              bigserial PRIMARY KEY,
  name            text NOT NULL,
  normalized_name text NOT NULL,
  industry        text,
  website         text,
  island          text,
  location        geography(Point,4326),
  is_demo         boolean NOT NULL DEFAULT false,
  source_id       text REFERENCES source_dataset(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX advertiser_norm_uq ON advertiser (normalized_name, is_demo);

CREATE TABLE advertiser_identifier (
  advertiser_id   bigint NOT NULL REFERENCES advertiser(id) ON DELETE CASCADE,
  system          text NOT NULL,
  external_id     text NOT NULL,
  external_name   text,
  PRIMARY KEY (system, external_id)
);

-- Contacts only from authorized sources (CRM, licensed Apollo export). Never inferred.
CREATE TABLE advertiser_contact (
  id              bigserial PRIMARY KEY,
  advertiser_id   bigint NOT NULL REFERENCES advertiser(id) ON DELETE CASCADE,
  full_name       text,
  role            text,
  email           text,
  phone           text,
  linkedin_url    text,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  source_record_ref text,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false
);

CREATE TABLE campaign (
  id              bigserial PRIMARY KEY,
  campaign_key    text NOT NULL UNIQUE,
  advertiser_id   bigint NOT NULL REFERENCES advertiser(id),
  name            text NOT NULL,
  objective       text,
  flight          daterange NOT NULL,
  budget_usd      numeric,
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN ('proposed','planned','live','completed','cancelled')),
  -- Attribution design declared up front
  attribution_window_days int,
  matching_method text,
  experiment_design text NOT NULL DEFAULT 'none' CHECK (experiment_design IN ('none','geo_holdout','matched_market','randomized_venue','pre_post_only')),
  is_demo         boolean NOT NULL DEFAULT false,
  source_id       text REFERENCES source_dataset(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE creative (
  id              bigserial PRIMARY KEY,
  campaign_id     bigint NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  creative_key    text NOT NULL,
  name            text NOT NULL,
  duration_s      numeric,
  qr_code_url     text,
  utm_campaign    text,
  coupon_code     text,
  is_demo         boolean NOT NULL DEFAULT false,
  UNIQUE (campaign_id, creative_key)
);

CREATE TABLE booking (
  id              bigserial PRIMARY KEY,
  booking_key     text NOT NULL UNIQUE,
  campaign_id     bigint NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  asset_id        bigint NOT NULL REFERENCES asset(id),
  period          daterange NOT NULL,
  units_booked    numeric NOT NULL CHECK (units_booked > 0),  -- in the asset's capacity unit
  unit            text NOT NULL CHECK (unit IN ('spot_slot','face_period')),
  status          text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('hold','confirmed','cancelled')),
  rate_usd        numeric,
  is_demo         boolean NOT NULL DEFAULT false,
  source_id       text REFERENCES source_dataset(id),
  source_record_ref text
);
CREATE INDEX booking_asset_idx ON booking (asset_id);

-- Read-only mirror of accounting invoice lines. Never written back to QuickBooks.
CREATE TABLE invoice_line (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  external_txn_id text NOT NULL,
  line_no         int NOT NULL,
  txn_type        text NOT NULL,          -- Invoice, SalesReceipt, CreditMemo
  txn_date        date NOT NULL,
  customer_name   text,
  customer_external_id text,
  advertiser_id   bigint REFERENCES advertiser(id),
  campaign_id     bigint REFERENCES campaign(id),
  item_name       text,
  description     text,
  amount_usd      numeric NOT NULL,
  service_date    date,
  import_run_id   bigint REFERENCES import_run(id),
  is_demo         boolean NOT NULL DEFAULT false,
  UNIQUE (source_id, external_txn_id, line_no)
);

-- ---------------------------------------------------------------------------
-- Delivery: schedules and proof of play
-- ---------------------------------------------------------------------------
CREATE TABLE proof_of_play (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  external_event_id text NOT NULL,        -- CMS play id or hash of (player, creative, timestamp)
  asset_id        bigint REFERENCES asset(id),
  player_id       text,
  creative_id     bigint REFERENCES creative(id),
  creative_ref    text,
  played_at       timestamptz NOT NULL,
  duration_s      numeric,
  import_run_id   bigint REFERENCES import_run(id),
  is_demo         boolean NOT NULL DEFAULT false,
  UNIQUE (source_id, external_event_id)
);
CREATE INDEX pop_asset_time_idx ON proof_of_play (asset_id, played_at);

-- ---------------------------------------------------------------------------
-- Observations: one generic, provenance-heavy table for every audience/traffic metric.
-- ---------------------------------------------------------------------------
CREATE TABLE metric_observation (
  id              bigserial PRIMARY KEY,
  subject_type    text NOT NULL CHECK (subject_type IN ('venue','asset','geo_area','campaign','network','route_segment')),
  subject_id      text NOT NULL,
  metric_code     text NOT NULL,
  metric_version  int NOT NULL DEFAULT 1,
  scenario        text NOT NULL DEFAULT 'point' CHECK (scenario IN ('point','low','base','high')),
  value           numeric,                       -- NULL only together with status 'unavailable'
  unit            text NOT NULL,
  period_start    date,
  period_end      date,
  geo_scope       text,                          -- e.g. '800m radius of venue point', 'census tract 15003003100'
  value_status    text NOT NULL CHECK (value_status IN ('observed','vendor_modeled','internally_modeled','assumed','unavailable')),
  source_id       text NOT NULL REFERENCES source_dataset(id),
  source_record_ref text,
  import_run_id   bigint REFERENCES import_run(id),
  imported_at     timestamptz NOT NULL DEFAULT now(),
  formula         text,
  inputs          jsonb NOT NULL DEFAULT '{}',  -- upstream observation ids / assumption codes and values
  sample_size     numeric,
  uncertainty     jsonb,                         -- only vendor-supplied intervals or documented MOE; never invented
  allowed_uses    text[] NOT NULL DEFAULT '{internal}',
  quality_flags   text[] NOT NULL DEFAULT '{}', -- 'stale','small_sample','duplicate','boundary_mismatch','extrapolated'
  is_demo         boolean NOT NULL DEFAULT false,
  CHECK ((value IS NULL) = (value_status = 'unavailable'))
);
CREATE INDEX metric_obs_subject_idx ON metric_observation (subject_type, subject_id, metric_code);
-- Idempotency key for imports: one value per subject/metric/period/scenario/source/version.
CREATE UNIQUE INDEX metric_obs_natural_uq ON metric_observation
  (subject_type, subject_id, metric_code, metric_version, scenario, source_id, coalesce(period_start,'1900-01-01'), coalesce(period_end,'1900-01-01'), is_demo);

CREATE TABLE traffic_count (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  station_id      text NOT NULL,
  road_name       text,
  location        geography(Point,4326),
  count_type      text NOT NULL CHECK (count_type IN ('AADT','ADT','hourly','pedestrian')),
  count_year      int,
  value           numeric NOT NULL,
  direction       text,
  import_run_id   bigint REFERENCES import_run(id),
  is_demo         boolean NOT NULL DEFAULT false,
  UNIQUE (source_id, station_id, count_type, count_year, direction)
);
CREATE INDEX traffic_count_gix ON traffic_count USING gist (location);

-- Points of interest near venues (OSM etc.) used for context & prospecting.
CREATE TABLE poi (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  external_id     text NOT NULL,
  name            text,
  category        text,
  subcategory     text,
  location        geography(Point,4326) NOT NULL,
  tags            jsonb NOT NULL DEFAULT '{}',
  import_run_id   bigint REFERENCES import_run(id),
  UNIQUE (source_id, external_id)
);
CREATE INDEX poi_gix ON poi USING gist (location);

-- ---------------------------------------------------------------------------
-- Outcomes
-- ---------------------------------------------------------------------------
CREATE TABLE conversion_event (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  external_event_id text NOT NULL,
  campaign_id     bigint REFERENCES campaign(id),
  creative_id     bigint REFERENCES creative(id),
  asset_id        bigint REFERENCES asset(id),
  event_type      text NOT NULL CHECK (event_type IN ('qr_scan','utm_visit','lead','purchase','coupon_redemption','store_visit')),
  occurred_at     timestamptz NOT NULL,
  value_usd       numeric,
  dedup_key       text,           -- cross-system dedup key (hashed order id, coupon code+txn); NULL = cannot dedup
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  import_run_id   bigint REFERENCES import_run(id),
  is_demo         boolean NOT NULL DEFAULT false,
  UNIQUE (source_id, external_event_id)
);
CREATE INDEX conversion_campaign_idx ON conversion_event (campaign_id, event_type);

CREATE TABLE attribution_result (
  id              bigserial PRIMARY KEY,
  campaign_id     bigint NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  result_type     text NOT NULL CHECK (result_type IN ('observed','attributed','incremental_lift')),
  metric          text NOT NULL,
  value           numeric,
  unit            text NOT NULL,
  method          text NOT NULL,
  window_days     int,
  design          text,
  control_desc    text,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  inputs          jsonb NOT NULL DEFAULT '{}',
  limitations     text NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  allowed_uses    text[] NOT NULL DEFAULT '{internal}',
  is_demo         boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Reconciliation / data quality
-- ---------------------------------------------------------------------------
CREATE TABLE match_exception (
  id              bigserial PRIMARY KEY,
  entity_type     text NOT NULL CHECK (entity_type IN ('venue','asset','advertiser','invoice_line','proof_of_play','conversion')),
  source_id       text NOT NULL REFERENCES source_dataset(id),
  source_record_ref text NOT NULL,
  issue           text NOT NULL,         -- 'no_coordinates','ambiguous_match','duplicate','unmatched','out_of_bounds','conflict', ...
  detail          text,
  candidate_ids   bigint[] NOT NULL DEFAULT '{}',
  candidate_scores numeric[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  resolution      text,
  resolved_by     text,
  resolved_at     timestamptz,
  import_run_id   bigint REFERENCES import_run(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, source_id, source_record_ref, issue)
);

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id              bigserial PRIMARY KEY,
  email           text NOT NULL UNIQUE,
  display_name    text,
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','analyst','sales','viewer')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled        boolean NOT NULL DEFAULT false
);

CREATE TABLE app_session (
  token_hash      text PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  user_id         bigint REFERENCES app_user(id),
  action          text NOT NULL,
  target          text,
  detail          jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schema_migration (
  version         text PRIMARY KEY,
  applied_at      timestamptz NOT NULL DEFAULT now()
);
