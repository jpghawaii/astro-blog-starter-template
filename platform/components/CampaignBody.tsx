import type { campaign } from "@/lib/campaign";
import { EstimateView, fmt, pct, Status } from "./ui";

type C = NonNullable<Awaited<ReturnType<typeof campaign>>>;

export function CampaignBody({ d, showRevenue, clientView }: { d: C; showRevenue: boolean; clientView: boolean }) {
  const { c } = d;
  const restricted = clientView && !d.allowed.includes("client_report");
  return (
    <>
      <h2>Campaign</h2>
      <table className="small"><tbody>
        <tr><td>Advertiser</td><td>{c.advertiser}{c.industry ? ` (${c.industry})` : ""}</td></tr>
        <tr><td>Flight</td><td>{c.flight_start} → {c.flight_end}</td></tr>
        <tr><td>Attribution window</td><td>{c.attribution_window_days != null ? `${c.attribution_window_days} days after flight end` : "not declared"}</td></tr>
        <tr><td>Matching method</td><td>{c.matching_method ?? "not declared"}</td></tr>
        <tr><td>Measurement design</td><td>{c.experiment_design.replace(/_/g, " ")}</td></tr>
      </tbody></table>

      <h2>Delivery</h2>
      <table><thead><tr><th>Venue / asset</th><th>Format</th><th>Dates</th><th className="n">Units</th><th className="n">Scheduled plays</th><th className="n">Verified plays</th><th>Delivery</th></tr></thead>
        <tbody>{d.delivery.map((b) => (
          <tr key={b.id}><td>{b.venue_name}<div className="muted small">{b.asset_name}</div></td><td>{b.format_name}</td><td className="small">{b.start} → {b.end} <span className="muted">({b.status})</span></td>
            <td className="n">{b.units_booked} {b.unit === "spot_slot" ? "slot" : "face"}</td>
            <td className="n">{b.digital ? fmt(b.scheduled) : "n/a (static)"}</td>
            <td className="n">{b.digital ? (b.verified_plays ? fmt(b.verified_plays) : <span className="badge b-unavailable">no proof-of-play</span>) : "n/a"}</td>
            <td>{b.digital ? (b.deliveryRate != null ? pct(b.deliveryRate) : "unavailable") : <span className="small muted">posting proof required</span>}</td></tr>
        ))}</tbody></table>
      <p className="small muted">Scheduled plays = flight days × operating hours × 3600 ÷ loop length × booked slots. Verified plays are proof-of-play records from the CMS for this campaign’s creatives.</p>

      <h2>Audience exposure</h2>
      {restricted ? <p>Exposure estimates are withheld from this client version under data-license terms.</p> : (
        <>
          <EstimateView e={d.gross} />
          <p className="small"><b>Gross contacts</b> add up per-asset contacts and count the same person each time they are exposed.</p>
          <table className="small"><tbody>
            <tr><td>Unique reach</td><td><Status s={d.reach.status} /> {d.reach.unavailableReason}</td></tr>
            <tr><td>Average frequency</td><td><Status s={d.frequency.status} /> {d.frequency.unavailableReason}</td></tr>
          </tbody></table>
          <details><summary className="small">Per-asset estimates</summary>{d.estimates.map((e) => <div key={e.asset.id} className="card" style={{ margin: "6px 0" }}><b>{e.asset.name}</b><EstimateView e={e.estimate} /></div>)}</details>
        </>
      )}

      <h2>Outcomes</h2>
      <h3>1. Observed events (in flight + {c.attribution_window_days ?? 0}-day window, campaign-tagged)</h3>
      {d.observed.bySourceAndType.length ? (
        <table className="small"><thead><tr><th>System</th><th>Event</th><th className="n">Count</th><th className="n">Value</th></tr></thead>
          <tbody>{d.observed.bySourceAndType.map((g) => <tr key={g.sourceId + g.eventType}><td className="mono">{g.sourceId}</td><td>{g.eventType.replace(/_/g, " ")}</td><td className="n">{fmt(g.count)}</td><td className="n">{g.valueUsd != null ? `$${fmt(g.valueUsd, 2)}` : "—"}</td></tr>)}</tbody></table>
      ) : <p className="small">No conversion events imported for this campaign.</p>}
      {d.observed.crossSystemTotal.filter((t) => t.uniqueCount === null || d.observed.bySourceAndType.filter((g) => g.eventType === t.eventType).length > 1).map((t) => (
        <p key={t.eventType} className="small">{t.eventType.replace(/_/g, " ")} across systems: {t.uniqueCount != null ? <b>{fmt(t.uniqueCount)} unique (deduplicated by order/coupon key)</b> : <span>not totalled — {t.reason}</span>}</p>
      ))}
      {d.observed.salesDeduplicated && (
        <p className="small">Sales (purchases + coupon redemptions across systems): {d.observed.salesDeduplicated.uniqueCount != null
          ? <b>{fmt(d.observed.salesDeduplicated.uniqueCount)} unique</b> : "not totalled"} — {d.observed.salesDeduplicated.reason}</p>
      )}
      {(d.observed.outsideWindow > 0 || d.observed.untagged > 0) && <p className="small muted">{d.observed.outsideWindow} tagged events fell outside the window and are excluded.</p>}

      <h3>2. Attributed results</h3>
      <p className="small">Events above are credited to the campaign only because they carry a campaign-specific identifier ({c.matching_method ?? "method not declared"}). This is attribution by tagging, not proof that the ads caused the action: some scanners or coupon users would have bought anyway.</p>

      <h3>3. Incremental lift</h3>
      {d.lift.available ? (
        <div className="small">
          <p>Design: <b>{d.lift.design.replace(/_/g, " ")}</b>. Difference-in-differences on store visits per store per day:
            test change {fmt(d.lift.testRateChange, 2)}, control change {fmt(d.lift.controlRateChange, 2)} → incremental {fmt(d.lift.incrementalPerUnitPerDay, 2)} per store per day,
            <b> {fmt(d.lift.incrementalTotal)} incremental visits</b> over the post period{d.lift.relativeLift != null ? ` (${pct(d.lift.relativeLift)} relative lift)` : ""}.</p>
          <ul>{d.lift.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      ) : <p className="small"><Status s="unavailable" /> {d.lift.reason}</p>}

      {showRevenue && !clientView && (
        <>
          <h2>Revenue reconciliation <span className="muted small">(internal)</span></h2>
          <table className="small"><thead><tr><th className="n">Booked value</th><th className="n">Invoiced (media)</th><th className="n">Difference</th><th>Flag</th></tr></thead>
            <tbody>{d.recon.rows.map((r) => <tr key={r.campaignId}><td className="n">{r.bookedValue != null ? `$${fmt(r.bookedValue, 2)}` : "unavailable"}</td><td className="n">${fmt(r.invoiced, 2)}</td><td className="n">{r.difference != null ? `$${fmt(r.difference, 2)}` : "—"}</td><td><span className={`badge ${r.flag === "ok" ? "b-observed" : "b-assumed"}`}>{r.flag.replace(/_/g, " ")}</span></td></tr>)}</tbody></table>
          {d.otherLines.length > 0 && <p className="small muted">{d.otherLines.length} non-media line(s) (tax/production/discount) excluded from the media comparison.</p>}
          <p className="small muted">{d.recon.note}</p>
        </>
      )}
    </>
  );
}
