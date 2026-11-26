import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { audit, CAN, requireUser } from "@/lib/auth";
import { q } from "@/lib/db";
import { AssetEstimate, venueProfile } from "@/lib/audience";
import { Demo, EstimateView, Flags, fmt, ObsValue, OBS_LABEL, Status } from "@/components/ui";
import { marketContext } from "@/lib/market";
import { MarketContextView } from "@/components/MarketContextView";

/** Collapses assets whose estimate is identical (e.g. 8 pump tops at one station) into one card. */
function groupEstimates(list: AssetEstimate[]) {
  const groups = new Map<string, { e: AssetEstimate; count: number }>();
  for (const e of list) {
    const k = JSON.stringify([e.asset.name, e.asset.format_code, e.asset.placement, e.asset.status, e.estimate.values, e.estimate.unavailableReason, e.needed]);
    const g = groups.get(k);
    if (g) g.count++; else groups.set(k, { e, count: 1 });
  }
  return [...groups.values()];
}

const COUNT_METRICS: Record<string, { label: string; unit: string; subject: "venue" | "asset" }> = {
  venue_visits: { label: "Venue visits (door count / visits)", unit: "visits", subject: "venue" },
  register_transactions: { label: "Register transactions", unit: "transactions", subject: "venue" },
  fueling_transactions: { label: "Fueling transactions", unit: "transactions", subject: "venue" },
  fueling_positions: { label: "Fueling positions (count)", unit: "positions", subject: "venue" },
  operating_hours_per_day: { label: "Screen operating hours per day", unit: "hours", subject: "venue" },
  hotel_occupancy_rate: { label: "Hotel occupancy rate (0-1)", unit: "share", subject: "venue" },
  lane_share: { label: "Share of transactions through media lanes (0-1)", unit: "share", subject: "venue" },
};

async function addCount(formData: FormData) {
  "use server";
  const user = await requireUser(["admin", "analyst"]);
  const venueId = String(formData.get("venue_id"));
  const code = String(formData.get("metric_code"));
  const value = Number(formData.get("value"));
  const ps = String(formData.get("period_start") || "") || null;
  const pe = String(formData.get("period_end") || "") || null;
  const evidence = String(formData.get("evidence") || "").trim();
  const def = COUNT_METRICS[code];
  if (!def || !Number.isFinite(value) || value < 0 || !evidence) throw new Error("metric, non-negative value and evidence reference are required");
  if (def.unit === "share" && value > 1) throw new Error("shares must be between 0 and 1");
  await q(
    `INSERT INTO metric_observation (subject_type, subject_id, metric_code, value, unit, period_start, period_end, geo_scope, value_status, source_id, source_record_ref, formula, allowed_uses)
     VALUES ('venue',$1,$2,$3,$4,$5,$6,'venue premises','observed','venue_provided',$7,'reported by venue',ARRAY['internal'])
     ON CONFLICT DO NOTHING`, [venueId, code, value, def.unit, ps, pe, evidence]);
  await audit(user.id, "add_venue_count", `venue:${venueId}`, { code, value, ps, pe, evidence });
  revalidatePath(`/venues/${venueId}`);
}

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const asOf = new Date().toISOString().slice(0, 10);
  const p = await venueProfile(id, asOf);
  if (!p) notFound();
  const market = await marketContext(p.venue);
  const { venue } = p;
  const ctx = (code: string) => p.context.find((c) => c.metric_code === code);
  const jobs = [400, 800, 1600].map((r) => ({ r, o: ctx(`workers_within_${r}m`) }));
  const aadt = ctx("aadt_nearest_road");
  const exceptions = await q<{ issue: string; detail: string }>(
    `SELECT issue, detail FROM match_exception WHERE status='open' AND (source_record_ref = ANY($1) OR source_record_ref ~ ('(^|[+])venue:'||$2||'([+]|$)'))`,
    [p.assets.map((a) => a.source_record_ref).filter(Boolean), id]);

  return (
    <>
      <p className="small"><Link href="/venues">← Venues</Link></p>
      <h1>{venue.name} <Demo on={venue.is_demo} /></h1>
      <p className="sub">{venue.address ?? "Address not in source"}{venue.city ? `, ${venue.city}` : ""} · {venue.island ?? "island unknown"} · {venue.venue_type.replace("_", " ")}
        {venue.operator_name ? ` · operator: ${venue.operator_name}` : ""} · location: {venue.location_quality.replace("_", " ")} · record status: <b>{venue.status}</b></p>
      <p className="noprint">
        <Link className="btn secondary" href={`/reports/media-sheet/${id}`}>Venue media sheet</Link>{" "}
        <Link className="btn secondary" href={`/reports/audience/${id}`}>Audience profile report</Link>
      </p>
      {exceptions.length > 0 && <div className="notice warn"><b>{exceptions.length} open data issue(s):</b><ul>{exceptions.slice(0, 6).map((e, i) => <li key={i}><b>{e.issue.replace(/_/g, " ")}</b>: {e.detail}</li>)}</ul></div>}

      <div className="cols">
        <div>
          <h2>Audience context (public data)</h2>
          <p className="small muted">These describe the area around the venue. They are <b>not</b> venue visitors and <b>not</b> ad impressions.</p>
          <div className="scroll"><table>
            <thead><tr><th>Indicator</th><th className="n">Value</th><th>Status</th><th>Scope</th><th>Source · vintage</th></tr></thead>
            <tbody>
              {jobs.map(({ r, o }) => (
                <tr key={r}><td>Jobs located within {r} m (workplace, all jobs)</td><td className="n">{fmt(o?.value)}</td><td><Status s={o ? o.value_status : "unavailable"} /><Flags flags={o?.quality_flags} /></td>
                  <td className="small">{o?.geo_scope ?? (venue.lat == null ? "venue has no location" : "—")}</td><td className="small mono">{o ? `${o.source_id} · ${o.period_start?.slice(0, 4)}` : "—"}</td></tr>
              ))}
              <tr><td>AADT, nearest state-inventoried road (vehicles/day, two-way)</td><td className="n">{fmt(aadt?.value)}</td><td><Status s={aadt ? aadt.value_status : "unavailable"} /><Flags flags={aadt?.quality_flags} /></td>
                <td className="small">{aadt?.geo_scope ?? "no HPMS segment within 60 m"}</td><td className="small mono">{aadt ? `${aadt.source_id} · ${aadt.period_start?.slice(0, 4)}` : "—"}</td></tr>
              {p.context.filter((c) => c.metric_code.startsWith("acs_")).map((c) => (
                <tr key={c.id}><td>{OBS_LABEL[c.metric_code] ?? c.metric_code}</td><td className="n"><ObsValue value={c.value} unit={c.unit} moe={c.uncertainty?.moe_90} /></td>
                  <td><Status s={c.value_status} /><Flags flags={c.quality_flags} /></td><td className="small">{c.geo_scope}</td><td className="small mono">{c.source_id} · {c.period_start?.slice(0, 4)}–{c.period_end?.slice(0, 4)}</td></tr>
              ))}
            </tbody>
          </table></div>
          {jobs[1].o?.inputs && (
            <details><summary className="small">Jobs within 800 m by industry (LODES CNS codes)</summary>
              <table className="small"><tbody>{Object.entries((jobs[1].o.inputs as { industry_jobs: Record<string, number> }).industry_jobs ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => <tr key={k}><td>{k}</td><td className="n">{fmt(v)}</td></tr>)}</tbody></table>
              <p className="muted small">Formula: {jobs[1].o.formula}. Blocks in radius: {fmt(jobs[1].o.sample_size)}. LODES block counts are noise-infused; radius totals are more reliable than single blocks.</p>
            </details>
          )}
          {aadt?.inputs && (
            <details><summary className="small">All HPMS road segments within 60 m</summary>
              <table className="small"><thead><tr><th>Route</th><th className="n">AADT</th><th className="n">Distance m</th><th>Class</th><th>Year</th></tr></thead>
                <tbody>{((aadt.inputs as { segments: { route_id: string; route_name: string; aadt: number; distance_m: number; f_system_t: string; year_record: number }[] }).segments ?? []).sort((a, b) => a.distance_m - b.distance_m).map((s, i) =>
                  <tr key={i}><td>{s.route_name ?? s.route_id}</td><td className="n">{fmt(s.aadt)}</td><td className="n">{s.distance_m}</td><td>{s.f_system_t}</td><td>{s.year_record}</td></tr>)}</tbody></table>
              <p className="muted small">Use a road's AADT for a face only after a site survey confirms the face is visible from that road.</p>
            </details>
          )}
          <p className="small muted">Resident figures describe people who live in the tract (ACS 5-year, ± 90% margin of error), not the venue’s visitors. “small sample” = coefficient of variation above 30%.</p>

          <h2>Market context</h2>
          <MarketContextView m={market} />

          <h2>Exposure estimates per asset <span className="muted small">({p.period.days}-day period ending {p.period.end})</span></h2>
          {groupEstimates(p.estimates).map(({ e, count }) => (
            <div className="card" key={e.asset.id} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div><b>{e.asset.name}</b>{count > 1 && <span className="badge b-neutral" style={{ marginLeft: 6 }}>× {count} identical units</span>} <Demo on={e.asset.is_demo} /> <span className="muted small">{e.asset.format_name} · {e.asset.placement ?? "placement n/a"} · status {e.asset.status}</span></div>
                <div className="small muted">allowed uses: {e.allowedUses.join(", ") || "none"}</div>
              </div>
              <EstimateView e={e.estimate} />
              {count > 1 && e.estimate.values && <div className="small muted">Estimate shown is per unit.</div>}
              {e.needed.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>To produce an estimate, supply:</b><ul style={{ margin: "4px 0" }}>{e.needed.map((n) => <li key={n}>{n}</li>)}</ul></div>}
            </div>
          ))}
          {!p.estimates.length && <p className="muted">No assets recorded for this venue.</p>}
        </div>

        <div>
          <h2>Assets</h2>
          <table className="small"><thead><tr><th>Asset</th><th>Format</th><th className="n">4-wk rate</th></tr></thead>
            <tbody>{p.assets.map((a) => <tr key={a.id}><td>{a.name}<div className="muted">{a.operator_frame_id ?? a.asset_key.slice(0, 40)}</div></td><td>{a.format_name}<div className="muted">{a.placement}</div></td>
              <td className="n" title={a.rate_text ?? ""}>{a.rate_4wk_usd ? `$${fmt(a.rate_4wk_usd)}` : <span className="muted">see note</span>}</td></tr>)}</tbody></table>
          <p className="small muted">Rates are list prices from the source sheet; package rates are kept as text and not divided per unit.</p>

          <h2>Venue-provided counts</h2>
          {p.venueCounts.length ? (
            <table className="small"><thead><tr><th>Metric</th><th className="n">Value</th><th>Period</th><th>Source</th></tr></thead>
              <tbody>{p.venueCounts.map((c) => <tr key={c.id}><td>{c.metric_code}</td><td className="n">{fmt(c.value, 2)}</td><td>{c.period_start ?? "—"} → {c.period_end ?? "—"}</td><td className="mono">{c.source_id}<div className="muted">{c.source_record_ref}</div></td></tr>)}</tbody></table>
          ) : <p className="muted small">None yet. Venue counts are required for impression estimates.</p>}
          {CAN.resolveExceptions(user.role) && (
            <form action={addCount} className="card" style={{ display: "grid", gap: 8 }}>
              <b className="small">Record a venue-provided count</b>
              <input type="hidden" name="venue_id" value={id} />
              <label>Metric<select name="metric_code">{Object.entries(COUNT_METRICS).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}</select></label>
              <label>Value<input name="value" type="number" step="any" min="0" required /></label>
              <div style={{ display: "flex", gap: 6 }}><label>From<input name="period_start" type="date" /></label><label>To<input name="period_end" type="date" /></label></div>
              <label>Evidence reference (document, email, report id)<input name="evidence" required placeholder="e.g. Store POS report Oct 2026, emailed 11/3" /></label>
              <button type="submit">Save observation</button>
              <span className="muted small">Saved as observed, source “venue_provided”, internal use only until the venue agreement permits client reporting.</span>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
