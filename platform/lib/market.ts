/**
 * Market context around a venue from official aggregate statistics:
 *   island visitors (DBEDT), local businesses by ZIP (Census ZBP), county industry jobs & wages (BLS QCEW).
 * Describes places and industries, never individuals. These are not venue visitors.
 */
import { demoFilter, q } from "./db";
import { permits, SourceLicense } from "./licensing";

/** Client version: drops any market statistic whose source does not permit client reports. */
export function restrictMarket(m: MarketContext, registry: Map<string, SourceLicense>): MarketContext {
  const ok = (o: { source_id: string } | undefined) => !o || permits(registry.get(o.source_id), "client_report");
  return {
    ...m,
    visitors: m.visitors.filter(ok),
    businesses: m.businesses.filter(ok),
    industries: m.industries.filter((i) => ok(i.jobs) && ok(i.wage) && ok(i.estabs)),
    sourceIds: m.sourceIds.filter((s) => permits(registry.get(s), "client_report")),
  };
}

export interface MarketObs { subject_id: string; metric_code: string; value: string | null; unit: string; period_start: string; period_end: string; geo_scope: string; source_id: string; quality_flags: string[] }
export interface MarketContext {
  island: string | null;
  visitors: MarketObs[];
  zip: string | null;
  zipSource: "address" | "census ZCTA" | null;
  businesses: MarketObs[];
  countyFips: string | null;
  industries: { sector: string; jobs: MarketObs | undefined; wage: MarketObs | undefined; estabs: MarketObs | undefined }[];
  sourceIds: string[];
}

const ISLAND_KEY: Record<string, string> = { Oahu: "Oahu", Maui: "Maui", Molokai: "Molokai", Lanai: "Lanai", Kauai: "Kauai", "Hawaii Island": "Hawaii Island" };

export async function marketContext(v: { island: string | null; zip: string | null; zcta?: string | null; county_fips?: string | null }): Promise<MarketContext> {
  const sel = `SELECT subject_id, metric_code, value, unit, period_start::text, period_end::text, geo_scope, source_id, quality_flags FROM metric_observation m`;
  const islandKey = v.island ? ISLAND_KEY[v.island] : undefined;
  const visitors = islandKey ? await q<MarketObs>(
    `${sel} WHERE subject_type='geo_area' AND subject_id=$1 AND metric_code LIKE 'visitor_%' AND ${demoFilter("m")}
     AND period_start = (SELECT max(period_start) FROM metric_observation WHERE subject_type='geo_area' AND subject_id=$1 AND metric_code LIKE 'visitor_%')
     ORDER BY metric_code`, [`island:${islandKey}`]) : [];
  const zip = v.zip && /^96[78]\d\d$/.test(v.zip) ? v.zip : v.zcta && v.zcta !== "99999" ? v.zcta : null;
  const businesses = zip ? await q<MarketObs>(`${sel} WHERE subject_type='geo_area' AND subject_id LIKE $1 AND metric_code='establishments' AND ${demoFilter("m")} ORDER BY value DESC`, [`zip:${zip}:naics:%`]) : [];
  const countyRows = v.county_fips ? await q<MarketObs>(`${sel} WHERE subject_type='geo_area' AND subject_id LIKE $1 AND source_id='bls_qcew' AND ${demoFilter("m")}`, [`county:${v.county_fips}:naics:%`]) : [];
  const sectors = [...new Set(countyRows.map((r) => r.subject_id))];
  const industries = sectors.map((s) => {
    const rows = countyRows.filter((r) => r.subject_id === s);
    const jobs = rows.find((r) => r.metric_code === "industry_jobs");
    return { sector: (jobs?.geo_scope ?? rows[0].geo_scope).split(", private, ")[1] ?? s, jobs, wage: rows.find((r) => r.metric_code === "industry_avg_weekly_wage"), estabs: rows.find((r) => r.metric_code === "industry_establishments") };
  }).sort((a, b) => Number(b.jobs?.value ?? -1) - Number(a.jobs?.value ?? -1));
  const sourceIds = [...new Set([...visitors, ...businesses, ...countyRows].map((r) => r.source_id))];
  return { island: v.island, visitors, zip, zipSource: zip ? (zip === v.zip ? "address" : "census ZCTA") : null, businesses, countyFips: v.county_fips ?? null, industries, sourceIds };
}
