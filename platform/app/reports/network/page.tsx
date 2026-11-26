import { CAN, requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";
import { nowHst, resolveAudience } from "@/lib/reporting";
import { fmt } from "@/components/ui";
import { ModeSwitch, ReportFooter } from "@/components/ReportParts";

export default async function NetworkReport({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  const user = await requireUser();
  const audience = resolveAudience(user, (await searchParams).audience);
  const rows = await q<{ format: string; island: string | null; venues: number; assets: number; located: number }>(
    `SELECT f.name format, v.island, count(DISTINCT v.id)::int venues, count(a.id)::int assets, count(DISTINCT v.id) FILTER (WHERE v.location IS NOT NULL)::int located
     FROM asset a JOIN venue v ON v.id=a.venue_id JOIN media_format f ON f.code=a.format_code WHERE ${demoFilter("a")} GROUP BY 1,2 ORDER BY 1,2`);
  const ctx = await q<{ format: string; n: number; p25: number; median: number; p75: number }>(
    `SELECT f.name format, count(*)::int n, percentile_cont(0.25) WITHIN GROUP (ORDER BY m.value) p25, percentile_cont(0.5) WITHIN GROUP (ORDER BY m.value) median, percentile_cont(0.75) WITHIN GROUP (ORDER BY m.value) p75
     FROM (SELECT DISTINCT v.id, a.format_code FROM venue v JOIN asset a ON a.venue_id=v.id WHERE ${demoFilter("v")}) va
     JOIN media_format f ON f.code=va.format_code
     JOIN metric_observation m ON m.subject_type='venue' AND m.subject_id=va.id::text AND m.metric_code='workers_within_800m'
     GROUP BY 1 ORDER BY 1`);
  const [hasDemo] = await q<{ d: boolean }>(`SELECT bool_or(is_demo) d FROM asset a WHERE ${demoFilter("a")}`);
  const totals = rows.reduce((t, r) => ({ venues: t.venues + r.venues, assets: t.assets + r.assets }), { venues: 0, assets: 0 });
  return (
    <>
      <ModeSwitch audience={audience} canInternal={CAN.viewRestrictedSources(user.role)} base="/reports/network" />
      <article className="report">
        <div className="small muted">JPG MEDIA · NETWORK OVERVIEW</div>
        <h1>JPG Media Hawaii out-of-home network</h1>
        <p>{fmt(totals.assets)} advertising units across Hawaii in JPG Media records (per-format venue counts below; a venue carrying two formats appears under both).</p>
        <h2>Inventory by format and island</h2>
        <table><thead><tr><th>Format</th><th>Island</th><th className="n">Venues</th><th className="n">Units</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{r.format}</td><td>{r.island ?? "not yet located"}</td><td className="n">{r.venues}</td><td className="n">{r.assets}</td></tr>)}</tbody></table>
        <p className="small">Counts reflect JPG Media inventory records as reconciled in November 2026 and are subject to confirmation against installed-equipment and venue-agreement records.</p>
        <h2>Daytime workforce near venues</h2>
        <p className="small">Jobs located within 800 m of each venue (U.S. Census LODES8 2024). Distribution across venues of each format; area context, not audience.</p>
        <table><thead><tr><th>Format</th><th className="n">Venues measured</th><th className="n">25th pct</th><th className="n">Median</th><th className="n">75th pct</th></tr></thead>
          <tbody>{ctx.map((c) => <tr key={c.format}><td>{c.format}</td><td className="n">{c.n}</td><td className="n">{fmt(c.p25)}</td><td className="n">{fmt(c.median)}</td><td className="n">{fmt(c.p75)}</td></tr>)}</tbody></table>
        <h2>Audience measurement status</h2>
        <p>Network-wide impressions, unique reach and frequency are <b>not stated</b> in this overview. Venue-level estimates are provided where measured venue traffic exists (see individual audience profiles); venue audiences are never summed into unique reach.</p>
        <ReportFooter sourceIds={["jpg_master_inventory", "census_lodes8"]} audience={audience} generated={nowHst()} hasDemo={!!hasDemo?.d} />
      </article>
    </>
  );
}
