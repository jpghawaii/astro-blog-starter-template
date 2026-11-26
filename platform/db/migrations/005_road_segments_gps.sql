-- Road segments (HDOT HPMS, with AADT) and vehicle GPS points for mobile-billboard exposure.
CREATE TABLE IF NOT EXISTS road_segment (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  segment_key     text NOT NULL,            -- route_id:bmp-emp
  route_id        text,
  route_name      text,
  island          text,
  functional_class text,
  aadt            numeric,                  -- two-way vehicles/day; NULL = not reported
  aadt_year       int,
  geom            geography(MultiLineString,4326) NOT NULL,
  import_run_id   bigint REFERENCES import_run(id),
  UNIQUE (source_id, segment_key)
);
CREATE INDEX IF NOT EXISTS road_segment_gix ON road_segment USING gist (geom);

-- GPS pings of JPG's OWN vehicles (vans, trucks). Vehicle positions only; no people data.
CREATE TABLE IF NOT EXISTS vehicle_gps_point (
  id              bigserial PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source_dataset(id),
  asset_id        bigint NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  vehicle_id      text,
  recorded_at     timestamptz NOT NULL,
  location        geography(Point,4326) NOT NULL,
  import_run_id   bigint REFERENCES import_run(id),
  is_demo         boolean NOT NULL DEFAULT false,
  UNIQUE (asset_id, recorded_at)
);
CREATE INDEX IF NOT EXISTS vehicle_gps_asset_time_idx ON vehicle_gps_point (asset_id, recorded_at);

INSERT INTO source_dataset (id, name, provider, category, access_method, license_name, permits_internal_analysis, permits_client_reports,
  permits_audience_activation, permits_redistribution, connection_status, notes)
VALUES ('vehicle_telematics','JPG vehicle GPS / telematics logs','JPG Media fleet','internal','csv_export','JPG Media internal',true,true,false,false,
        'configured_untested','Timestamped GPS pings of JPG vans/trucks (templates/vehicle_gps.csv). No GPS logs imported yet.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metric_definition (code, version, name, unit, definition, formula, applies_to, cautions) VALUES
('route_exposure',1,'Vehicle route exposure','seconds','Seconds a vehicle spent on each HPMS road segment in a period, from GPS pings snapped to the nearest segment within 40 m.',
 'SUM(min(gap,120s)) per nearest segment',ARRAY['vehicle'],'Off-network roads (no HPMS segment within 40 m) are counted as unmatched time, not exposure.')
ON CONFLICT DO NOTHING;
