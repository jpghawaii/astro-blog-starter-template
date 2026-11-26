-- Invoice lines: keep the accounting account and a derived revenue class so that tax pass-through,
-- discounts and production fees are never summed with media revenue.
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS account_name text;
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS revenue_class text
  CHECK (revenue_class IN ('media','production','tax','discount','fee','other'));
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS venue_id bigint REFERENCES venue(id);

-- Radius-specific LODES metric definitions (versioned like all metrics).
INSERT INTO metric_definition (code, version, name, unit, definition, formula, applies_to, cautions)
SELECT 'workers_within_' || r || 'm', 1, 'Jobs within ' || r || ' m (workplace)', 'jobs', d.definition, d.formula, d.applies_to, d.cautions
FROM metric_definition d, unnest(ARRAY[400, 800, 1600]) r
WHERE d.code = 'workers_within_radius'
ON CONFLICT DO NOTHING;

INSERT INTO metric_definition (code, version, name, unit, definition, formula, applies_to, cautions) VALUES
('hotel_occupancy_rate',1,'Hotel occupancy rate','share','Share of available rooms occupied in the month for a DBEDT hotel region, or venue-reported.','DBEDT/STR published',ARRAY['geo_area','venue'],'STR sample-based; region average, not the specific hotel.'),
('crm_pipeline',1,'CRM pipeline value','USD','Estimated deal value from the CRM board (blank = unavailable).','as entered in CRM',ARRAY['network'],'Sales estimate, not revenue.'),
('acs_population_tract',1,'Residents in tract','people','ACS 5-year total population of the census tract containing the venue.','B01003_001E',ARRAY['venue'],'Residents, not visitors.'),
('acs_median_hh_income_tract',1,'Median household income (tract residents)','USD','ACS 5-year median household income of the tract containing the venue.','B19013_001E',ARRAY['venue'],'Residents, not visitors; check MOE.')
ON CONFLICT DO NOTHING;
