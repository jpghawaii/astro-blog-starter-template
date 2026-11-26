import { notFound } from "next/navigation";
import { CAN, requireUser } from "@/lib/auth";
import { campaign } from "@/lib/campaign";
import { demoFilter, q } from "@/lib/db";
import { nowHst, resolveAudience } from "@/lib/reporting";
import { fmt } from "@/components/ui";
import { ModeSwitch, ReportFooter } from "@/components/ReportParts";

export default async function Proposal({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ audience?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const audience = resolveAudience(user, (await searchParams).audience);
  const d = await campaign(id);
  if (!d) notFound();
  const venueIds = [...new Set(d.bookings.map((b) => b.venue_id))];
  const ctx = await q<{ subject_id: string; metric_code: string; value: string; period_start: string }>(
    `SELECT subject_id, metric_code, value, period_start::text FROM metric_observation m WHERE subject_type='venue' AND subject_id = ANY($1)
     AND metric_code IN ('workers_within_800m','aadt_nearest_road') AND ${demoFilter("m")}`, [venueIds]);
  const total = d.bookings.reduce((s, b) => s + (b.rate_usd ? Number(b.rate_usd) * Number(b.units_booked) : 0), 0);
  const show = (e: typeof d.estimates[0]) => audience === "internal" || e.allowedUses.includes("client_report");
  return (
    <>
      <ModeSwitch audience={audience} canInternal={CAN.viewRestrictedSources(user.role)} base={`/reports/proposal/${id}`} />
      <article className="report">
        <div className="small muted">JPG MEDIA · CAMPAIGN PROPOSAL</div>
        <h1>{d.c.name}</h1>
        <p>Prepared for {d.c.advertiser} · Flight {d.c.flight_start} → {d.c.flight_end}</p>
        <h2>Recommended placements</h2>
        <table><thead><tr><th>Venue</th><th>Island</th><th>Format</th><th className="n">Units</th><th className="n">Jobs ≤800 m</th><th className="n">Road AADT</th><th className="n">Rate (4 wk)</th></tr></thead>
          <tbody>{d.bookings.map((b) => {
            const j = ctx.find((c) => c.subject_id === b.venue_id && c.metric_code === "workers_within_800m");
            const t = ctx.find((c) => c.subject_id === b.venue_id && c.metric_code === "aadt_nearest_road");
            return <tr key={b.id}><td>{b.venue_name}<div className="small muted">{b.asset_name}</div></td><td>{b.island}</td><td>{b.format_name}</td><td className="n">{b.units_booked}</td>
              <td className="n">{fmt(j?.value)}</td><td className="n">{fmt(t?.value)}</td><td className="n">{b.rate_usd ? `$${fmt(b.rate_usd)}` : "on request"}</td></tr>;
          })}</tbody></table>
        <p><b>Total media (list): ${fmt(total)}</b> per flight{d.c.budget_usd ? ` · stated budget $${fmt(d.c.budget_usd)}` : ""}. Production and General Excise tax not included.</p>
        <h2>Expected exposure</h2>
        <table className="small"><thead><tr><th>Asset</th><th>Measure (28 days)</th><th className="n">Low</th><th className="n">Base</th><th className="n">High</th></tr></thead>
          <tbody>{d.estimates.map((e) => <tr key={e.asset.id}><td>{e.asset.name}</td>
            {e.estimate.values && show(e)
              ? <><td>{e.estimate.metric.replace(/_/g, " ")}</td><td className="n">{fmt(e.estimate.values.low)}</td><td className="n">{fmt(e.estimate.values.base)}</td><td className="n">{fmt(e.estimate.values.high)}</td></>
              : <td colSpan={4} className="muted">unavailable{e.estimate.values ? " in this version (license)" : ": " + (e.estimate.unavailableReason ?? "")}</td>}</tr>)}</tbody></table>
        <p className="small">Unique reach and frequency are not projected: venue audiences overlap and JPG Media does not sum them into unique people without licensed overlap data.</p>
        <h2>How results will be measured</h2>
        <ul className="small">
          <li>Delivery: proof-of-play records from the screen network (digital) and dated posting photos (static).</li>
          <li>Response: {d.c.matching_method ?? "campaign-specific QR code / URL / coupon to be agreed"}; attribution window {d.c.attribution_window_days ?? "to be agreed"} days after the flight.</li>
          <li>Incremental lift: {d.c.experiment_design === "none" ? "not planned. To measure lift, agree a holdout group of comparable locations before launch." : `planned via ${d.c.experiment_design.replace(/_/g, " ")} design.`}</li>
        </ul>
        <ReportFooter sourceIds={["jpg_master_inventory", "census_lodes8", "hdot_hpms_2024", "jpg_model", "jpg_assumptions", ...d.estimates.filter(show).flatMap((e) => e.sourceIds)]} audience={audience} generated={nowHst()} hasDemo={d.c.is_demo} />
      </article>
    </>
  );
}
