import { notFound } from "next/navigation";
import { CAN, requireUser } from "@/lib/auth";
import { restrictForClient, venueProfile } from "@/lib/audience";
import { nowHst, resolveAudience, todayHst } from "@/lib/reporting";
import { EstimateView, Flags, fmt, ObsValue, OBS_LABEL, Status } from "@/components/ui";
import { marketContext, restrictMarket } from "@/lib/market";
import { MarketContextView } from "@/components/MarketContextView";
import { ModeSwitch, ReportFooter } from "@/components/ReportParts";

export default async function AudienceReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ audience?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const audience = resolveAudience(user, (await searchParams).audience);
  const full = await venueProfile(id, todayHst());
  if (!full) notFound();
  const restricted = restrictForClient(full);
  const p = audience === "client" ? restricted : full;
  const v = p.venue;
  const groups = new Map<string, typeof p.estimates>();
  for (const e of p.estimates) {
    const k = JSON.stringify([e.asset.format_code, e.asset.placement, e.estimate.values, e.estimate.unavailableReason]);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const fullMarket = await marketContext(full.venue);
  const market = audience === "client" ? restrictMarket(fullMarket, full.registry) : fullMarket;
  const industry = (p.context.find((c) => c.metric_code === "workers_within_800m")?.inputs as { industry_jobs?: Record<string, number> } | undefined)?.industry_jobs;
  const shownSources = audience === "internal" ? [...full.usedSourceIds, ...market.sourceIds] : [...new Set([...market.sourceIds,v.source_id, ...p.assets.map((a) => a.source_id), ...p.context.map((c) => c.source_id), ...p.estimates.flatMap((e) => e.estimate.values ? e.sourceIds : [])])];
  return (
    <>
      <ModeSwitch audience={audience} canInternal={CAN.viewRestrictedSources(user.role)} base={`/reports/audience/${id}`} />
      <article className="report">
        <div className="small muted">JPG MEDIA · AUDIENCE PROFILE</div>
        <h1>{v.name}</h1>
        <p>{v.address ?? ""}{v.city ? `, ${v.city}` : ""} · {v.island ?? ""} · Estimates for the {p.period.days}-day period ending {p.period.end}</p>

        <h2>1. Who is around this venue</h2>
        <p className="small">Area indicators from official public datasets. Workers are people employed at workplaces nearby (daytime population), not shoppers; road traffic is vehicles on the adjacent road, not venue visitors.</p>
        <table><thead><tr><th>Indicator</th><th className="n">Value</th><th>Geography</th><th>Source · year</th><th>Status</th></tr></thead>
          <tbody>{p.context.map((c) => <tr key={c.id}><td>{OBS_LABEL[c.metric_code] ?? c.metric_code}</td><td className="n"><ObsValue value={c.value} unit={c.unit} moe={c.uncertainty?.moe_90} /></td><td className="small">{c.geo_scope}</td>
            <td className="small">{c.source_id} · {c.metric_code.startsWith("acs_") ? `${c.period_start?.slice(0, 4)}–${c.period_end?.slice(0, 4)}` : c.period_start?.slice(0, 4)}</td><td><Status s={c.value_status} /><Flags flags={c.quality_flags} /></td></tr>)}
            {!p.context.length && <tr><td colSpan={5}>Unavailable: the venue location has not been verified, so area indicators cannot be computed.</td></tr>}</tbody></table>
        {industry && <><h3>Jobs within 800 m by industry</h3><table className="small"><tbody>{Object.entries(industry).sort((a, b) => b[1] - a[1]).map(([k, n]) => <tr key={k}><td>{k}</td><td className="n">{fmt(n)}</td></tr>)}</tbody></table></>}
        <p className="small">Resident demographics describe people who live in the venue’s census tract (ACS 5-year, ± 90% margin of error), not the venue’s actual visitors. Visitor demographics require licensed visitation data and are shown only when available.</p>

        <h2>Market context</h2>
        <MarketContextView m={market} />

        <h2>2. Exposure estimates</h2>
        {[...groups.values()].map((list) => { const e = list[0]; return (
          <div key={e.asset.id} style={{ marginBottom: 14 }}>
            <b>{e.asset.format_name}</b> · {e.asset.placement ?? ""} {list.length > 1 ? `(${list.length} units, per-unit figures)` : `(${e.asset.name})`}
            <EstimateView e={e.estimate} open />
            {e.needed.length > 0 && <div className="small">Data required: {e.needed.join("; ")}.</div>}
          </div>); })}
        {audience === "client" && restricted.excluded.length > 0 && <p className="small">Some estimates are withheld from this version under data-license terms.</p>}
        <p className="small"><b>Unique reach and frequency:</b> unavailable. Visits to separate venues and screens overlap; they are not added together as unique people without licensed overlap data.</p>
        <ReportFooter sourceIds={shownSources} audience={audience} excluded={restricted.excluded} generated={nowHst()} hasDemo={v.is_demo} />
      </article>
    </>
  );
}
