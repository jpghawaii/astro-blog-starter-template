-- Additional official public sources: BLS QCEW and Census ZIP Business Patterns; HTA/HLTA registry rows.
INSERT INTO source_dataset (id, name, provider, category, access_method, documentation_url, license_name, attribution_text,
  permits_internal_analysis, permits_client_reports, permits_audience_activation, permits_redistribution, connection_status, geographic_coverage, refresh_cadence, notes) VALUES
('bls_qcew','Quarterly Census of Employment and Wages (QCEW)','U.S. Bureau of Labor Statistics','public','bulk_download','https://www.bls.gov/cew/additional-resources/open-data/',
 'U.S. Government work (public domain)','Source: U.S. Bureau of Labor Statistics, QCEW.',true,true,true,true,'tested_working','Hawaii counties x industry','Quarterly (~5-month lag)',
 'UI-covered jobs, establishments and wages. Suppressed cells are stored as unavailable (never 0).'),
('census_zbp','ZIP Code Business Patterns (ZBP)','U.S. Census Bureau','public','bulk_download','https://www.census.gov/programs-surveys/cbp.html',
 'U.S. Government work (public domain)','Source: U.S. Census Bureau, ZIP Code Business Patterns.',true,true,true,true,'tested_working','Hawaii ZIP codes x NAICS','Annual (latest 2023)',
 'Establishment counts only (no jobs/payroll at ZIP-industry level). Mid-March reference week.'),
('hta_research','Hawaii Tourism Authority research & market reports','Hawaii Tourism Authority','public','manual',NULL,'State of Hawaii public information',
 NULL,true,NULL,NULL,NULL,'not_connected','Hawaii',NULL,
 'Official visitor statistics are produced by DBEDT (imported as dbedt_visitor_stats). Import HTA market-specific reports manually as files.'),
('hlta_member_reports','Hawaii Lodging & Tourism Association member reports','HLTA (data typically from STR)','commercial','licensed_file',NULL,
 'HLTA membership / STR terms (contract review required)',NULL,NULL,NULL,false,false,'needs_subscription','Hawaii hotels',NULL,
 'Member-only hotel performance data; usually STR-licensed. Import exports you are entitled to; no use permitted until terms are recorded.')
ON CONFLICT (id) DO NOTHING;

UPDATE source_dataset SET connection_status='tested_working', notes = notes || ' Bulk table-based Summary File path needs no key and is used by default.'
WHERE id='census_acs5' AND connection_status <> 'tested_working';

INSERT INTO metric_definition (code, version, name, unit, definition, formula, applies_to, cautions) VALUES
('visitor_avg_daily_census',1,'Visitors present per day (island)','visitors','Average number of visitors on the island on any given day in the month.','visitor days / days in month',ARRAY['geo_area'],'Island-wide; not visitors at a venue.'),
('visitor_spend_per_person_day',1,'Visitor spending per person per day','USD','DBEDT survey-based average daily spending per visitor.','DBEDT',ARRAY['geo_area'],'Survey estimate; preliminary months revised.'),
('visitor_expenditures',1,'Visitor expenditures (island, month)','USD millions','Total visitor spending on the island in the month.','DBEDT',ARRAY['geo_area'],'Preliminary.'),
('industry_jobs',1,'Private jobs by industry (county)','jobs','QCEW third-month employment for the county and supersector.','QCEW month3_emplvl',ARRAY['geo_area'],'UI-covered jobs only.'),
('industry_avg_weekly_wage',1,'Average weekly wage by industry (county)','USD/week','QCEW average weekly wage.','QCEW avg_wkly_wage',ARRAY['geo_area'],NULL),
('establishments',1,'Establishments by industry (ZIP)','establishments','Census ZBP establishment count for the ZIP and NAICS group.','ZBP est',ARRAY['geo_area'],'Counts businesses, not their size or sales.'),
('acs_commute_drove_alone_share_tract',1,'Workers driving alone (tract residents)','share','Share of resident workers who drive alone to work.','B08301_003/B08301_001',ARRAY['venue'],'Residents of the tract; check MOE.'),
('acs_households_no_vehicle_share_tract',1,'Households with no vehicle (tract)','share','Share of occupied housing units with no vehicle available.','(B25044_003+B25044_010)/B25044_001',ARRAY['venue'],'Residents; small shares are often unreliable.')
ON CONFLICT DO NOTHING;
