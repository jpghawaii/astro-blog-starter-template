import { notFound } from "next/navigation";
import { CAN, requireUser } from "@/lib/auth";
import { restrictForClient, venueProfile } from "@/lib/audience";
import { nowHst, resolveAudience, todayHst } from "@/lib/reporting";
import { fmt, Status } from "@/components/ui";
import { ModeSwitch, ReportFooter } from "@/components/ReportParts";

export default async function MediaSheet({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ audience?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const audience = resolveAudience(user, (await searchParams).audience);
  const full = await venueProfile(id, todayHst());
  if (!full) notFound();
  const restricted = restrictForClient(full);
  const p = audience === "client" ? restricted : { ...full, excluded: restricted.excluded };
  const v = p.venue;
  const byFormat = new Map<string, typeof p.assets>();
  for (const a of p.assets) byFormat.set(a.format_name, [...(byFormat.get(a.format_name) ?? []), a]);
  const ctx = (c: string) => p.context.find((o) => o.metric_code === c);
  const aadt = ctx("aadt_nearest_road");
  const hasDemo = v.is_demo || p.assets.some((a) => a.is_demo);
  const shownSources = audience === "internal" ? full.usedSourceIds : [...new Set([v.source_id, ...p.assets.map((a) => a.source_id), ...p.context.map((c) => c.source_id), ...p.estimates.flatMap((e) => e.sourceIds)])];
  return (
    <>
      <ModeSwitch audience={audience} canInternal={CAN.viewRestrictedSources(user.role)} base={`/reports/media-sheet/${id}`} />
      <article className="report">
        <div className="small muted">JPG MEDIA · VENUE MEDIA SHEET</div>
        <h1>{v.name}</h1>
        <p>{v.address ?? "Address on request"}{v.city ? `, ${v.city}` : ""} · {v.island ?? ""} · {v.venue_type.replace("_", " ")}</p>
        <h2>Available media</h2>
        <table><thead><tr><th>Format</th><th>Placement</th><th className="n">Units</th><th>Size / spec</th><th>4-week list rate</th></tr></thead>
          <tbody>{[...byFormat.entries()].flatMap(([f, list]) => {
            const placements = [...new Set(list.map((a) => a.placement ?? "—"))];
            return placements.map((pl) => {
              const sub = list.filter((a) => (a.placement ?? "—") === pl);
              const a = sub[0];
              const size = a.width_in && a.height_in ? `${fmt(a.width_in)}″ × ${fmt(a.height_in)}″` : a.is_digital ? `${a.spot_length_s ?? 15}s spots` : "on request";
              return <tr key={f + pl}><td>{f}</td><td>{pl}</td><td className="n">{sub.length}</td><td>{size}</td>
                <td>{a.rate_4wk_usd ? `$${fmt(a.rate_4wk_usd)} per unit` : a.rate_text ? <span className="small">{a.rate_text}</span> : "on request"}</td></tr>;
            });
          })}</tbody></table>
        <p className="small">Inventory per JPG records as of {todayHst()}; availability for specific flight dates must be confirmed before booking.</p>
        <h2>Area context</h2>
        <table><tbody>
          {[400, 800, 1600].map((r) => { const o = ctx(`workers_within_${r}m`); return <tr key={r}><td>Jobs located within {r} m</td><td className="n">{fmt(o?.value)}</td><td className="small">{o ? `U.S. Census LODES8, ${o.period_start?.slice(0, 4)}` : "unavailable"}</td></tr>; })}
          <tr><td>Average daily traffic on nearest state-inventoried road</td><td className="n">{fmt(aadt?.value)}</td><td className="small">{aadt ? `HDOT HPMS ${aadt.period_start?.slice(0, 4)}; ${aadt.geo_scope}` : "unavailable"}</td></tr>
        </tbody></table>
        <p className="small">These figures describe the surrounding area (people employed nearby; vehicles on the adjacent road). They are not counts of venue visitors or ad impressions.</p>
        <h2>Audience estimates</h2>
        {p.estimates.some((e) => e.estimate.values) ? (
          <table><thead><tr><th>Unit</th><th>Measure ({p.period.days} days)</th><th className="n">Low</th><th className="n">Base</th><th className="n">High</th><th>Basis</th></tr></thead>
            <tbody>{p.estimates.filter((e) => e.estimate.values).slice(0, 12).map((e) => <tr key={e.asset.id}><td>{e.asset.name}</td><td>{e.estimate.metric.replace(/_/g, " ")}</td>
              <td className="n">{fmt(e.estimate.values!.low)}</td><td className="n">{fmt(e.estimate.values!.base)}</td><td className="n">{fmt(e.estimate.values!.high)}</td><td><Status s={e.estimate.status} /></td></tr>)}</tbody></table>
        ) : <p>Audience estimates for this venue are <b>unavailable</b> pending measured venue traffic. JPG Media does not publish impression figures without a measured traffic basis.</p>}
        <ReportFooter sourceIds={shownSources} audience={audience} excluded={p.excluded} generated={nowHst()} hasDemo={hasDemo} />
      </article>
    </>
  );
}
