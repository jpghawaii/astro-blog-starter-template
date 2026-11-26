-- Census geographies of each venue point (from the LODES 2020-block crosswalk), used to join area statistics.
ALTER TABLE venue ADD COLUMN IF NOT EXISTS county_fips text;
ALTER TABLE venue ADD COLUMN IF NOT EXISTS tract_geoid text;
ALTER TABLE venue ADD COLUMN IF NOT EXISTS zcta text;
ALTER TABLE venue ADD COLUMN IF NOT EXISTS block_geoid text;
