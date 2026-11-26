-- DBEDT's own visitor survey statistics are separated from the STR-derived hotel performance data,
-- because their reporting permissions differ.
INSERT INTO source_dataset (id, name, provider, category, access_method, documentation_url, license_name, attribution_text,
  permits_internal_analysis, permits_client_reports, permits_audience_activation, permits_redistribution, connection_status, geographic_coverage, refresh_cadence, notes)
VALUES ('dbedt_visitor_research','DBEDT monthly visitor statistics (visitor survey)','Hawaii DBEDT Research & Economic Analysis','public','bulk_download',
 'https://dbedt.hawaii.gov/economic/tourism/monthly-statistics/','State of Hawaii public statistics (cite DBEDT)','Source: Hawaii Department of Business, Economic Development & Tourism (DBEDT).',
 true,true,NULL,NULL,'tested_working','Hawaii by island','Monthly (preliminary, later revised)',
 'Arrivals, visitor days, average daily census, length of stay, spending. Island-wide statistics, not venue visitors.')
ON CONFLICT (id) DO NOTHING;

UPDATE metric_observation SET source_id='dbedt_visitor_research'
WHERE source_id='dbedt_visitor_stats' AND subject_type='geo_area' AND subject_id LIKE 'island:%';

UPDATE source_dataset SET name='DBEDT monthly hotel performance (STR-sourced)', notes='Hotel occupancy/ADR/RevPAR published by DBEDT from STR, Inc. data. Client-report use pending confirmation of DBEDT/STR terms.'
WHERE id='dbedt_visitor_stats';
