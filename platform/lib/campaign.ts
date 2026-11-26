import { demoFilter, q } from "./db";
import { AssetEstimate, loadRegistry, venueProfile } from "./audience";
import { allowedUses } from "./licensing";
import { sumContacts } from "./measurement/models";
import { uniqueReach } from "./measurement/reach";
import { differenceInDifferences, summarizeObserved, ConversionEvent, Design, LiftResult } from "./outcomes";
import { reconcileRevenue } from "./reconcile";

export interface CampaignRow {
  id: string; campaign_key: string; name: string; advertiser: string; industry: string | null; flight_start: string; flight_end: string; budget_usd: string | null;
  status: string; attribution_window_days: number | null; matching_method: string | null; experiment_design: Design; is_demo: boolean;
}
export interface BookingDetail {
  id: string; asset_id: string; asset_name: string; format_name: string; format_code: string; venue_id: string; venue_name: string; island: string | null;
  start: string; end: string; units_booked: string; unit: string; status: string; rate_usd: string | null; loop_length_s: string | null; hours: string | null;
  verified_plays: number; is_demo: boolean;
}

export async function campaign(id: string) {
  const [c] = await q<CampaignRow>(
    `SELECT c.id::text, campaign_key, c.name, a.name advertiser, a.industry, lower(flight)::text flight_start, (upper(flight)-1)::text flight_end, budget_usd, status,
            attribution_window_days, matching_method, experiment_design, c.is_demo FROM campaign c JOIN advertiser a ON a.id=c.advertiser_id WHERE c.id=$1 AND ${demoFilter("c")}`, [id]);
  if (!c) return null;
  const bookings = await q<BookingDetail>(
    `SELECT b.id::text, a.id::text asset_id, a.name asset_name, f.name format_name, f.code format_code, v.id::text venue_id, v.name venue_name, v.island,
            lower(b.period)::text start, (upper(b.period)-1)::text "end", units_booked, b.unit, b.status, b.rate_usd, a.loop_length_s,
            (SELECT value FROM metric_observation m WHERE m.subject_type='venue' AND m.subject_id=v.id::text AND m.metric_code='operating_hours_per_day' ORDER BY period_end DESC NULLS LAST LIMIT 1) hours,
            (SELECT count(*) FROM proof_of_play p JOIN creative cr ON cr.id=p.creative_id WHERE p.asset_id=a.id AND cr.campaign_id=b.campaign_id AND p.played_at::date <@ b.period)::int verified_plays,
            b.is_demo
     FROM booking b JOIN asset a ON a.id=b.asset_id JOIN venue v ON v.id=a.venue_id JOIN media_format f ON f.code=a.format_code
     WHERE b.campaign_id=$1 AND b.status <> 'cancelled' ORDER BY v.name`, [id]);

  // Delivery: verified plays vs scheduled plays (scheduled = days x hours x 3600 / loop x booked slots).
  const delivery = bookings.map((b) => {
    const days = (Date.parse(b.end) - Date.parse(b.start)) / 86_400_000 + 1;
    const scheduled = b.loop_length_s && b.hours ? Math.floor((days * Number(b.hours) * 3600) / Number(b.loop_length_s)) * Number(b.units_booked) : null;
    return { ...b, days, scheduled, deliveryRate: scheduled && b.verified_plays ? b.verified_plays / scheduled : null, digital: b.unit === "spot_slot" };
  });

  // Exposure estimates per booked asset (period ending at flight end).
  const venueIds = [...new Set(bookings.map((b) => b.venue_id))];
  const estimates: AssetEstimate[] = [];
  for (const vid of venueIds) {
    const p = await venueProfile(vid, c.flight_end);
    if (p) estimates.push(...p.estimates.filter((e) => bookings.some((b) => b.asset_id === e.asset.id)));
  }
  const gross = sumContacts(estimates.map((e) => e.estimate));
  const { reach, frequency } = uniqueReach(venueIds, gross, null);

  // Outcomes
  const events = await q<{ id: string; source_id: string; event_type: ConversionEvent["eventType"]; occurred_at: string; value_usd: string | null; dedup_key: string | null; campaign_id: string | null }>(
    `SELECT id::text, source_id, event_type, occurred_at::text, value_usd, dedup_key, campaign_id::text FROM conversion_event e WHERE campaign_id=$1 AND ${demoFilter("e")}`, [id]);
  const window = { flightStart: c.flight_start, flightEnd: c.flight_end, windowDays: c.attribution_window_days ?? 0 };
  const observed = summarizeObserved(events.map((e) => ({ id: e.id, sourceId: e.source_id, eventType: e.event_type, occurredAt: e.occurred_at, valueUsd: e.value_usd ? Number(e.value_usd) : null, dedupKey: e.dedup_key, campaignTagged: true })), window);

  const liftObs = await q<{ metric_code: string; value: string; source_id: string; inputs: { units: number; days: number } }>(
    `SELECT metric_code, value, source_id, inputs FROM metric_observation m WHERE subject_type='campaign' AND subject_id=$1 AND metric_code LIKE 'lift_%' AND ${demoFilter("m")}`, [id]);
  const L = (k: string) => liftObs.find((o) => o.metric_code === k);
  const group = (pre?: typeof liftObs[0], post?: typeof liftObs[0]) => pre && post ? { pre: Number(pre.value), post: Number(post.value), preDays: pre.inputs.days, postDays: post.inputs.days, units: pre.inputs.units } : null;
  const test = group(L("lift_test_pre"), L("lift_test_post"));
  const lift: LiftResult = test
    ? differenceInDifferences(c.experiment_design, test, group(L("lift_control_pre"), L("lift_control_post")))
    : { available: false, design: c.experiment_design, reason: c.experiment_design === "none" ? "No control group was designed; incremental lift cannot be claimed." : "Design declared but no test/control outcome data imported yet.", limitations: [] };

  // Revenue reconciliation (booked value vs invoiced media revenue)
  const lines = await q<{ id: string; amount_usd: string; txn_date: string; customer_name: string; revenue_class: string | null }>(
    `SELECT id::text, amount_usd, txn_date::text, customer_name, revenue_class FROM invoice_line l WHERE campaign_id=$1 AND ${demoFilter("l")}`, [id]);
  const bookedValue = bookings.reduce((s, b) => s + (b.rate_usd ? Number(b.rate_usd) * Number(b.units_booked) : 0), 0);
  const recon = reconcileRevenue([{ campaignId: id, advertiser: c.advertiser, bookedValue: bookings.some((b) => b.rate_usd) ? bookedValue : null, flightStart: c.flight_start, flightEnd: c.flight_end }],
    lines.filter((l) => (l.revenue_class ?? "media") === "media").map((l) => ({ id: l.id, campaignId: id, customer: l.customer_name, amount: Number(l.amount_usd), date: l.txn_date })));
  const otherLines = lines.filter((l) => l.revenue_class && l.revenue_class !== "media");

  const registry = await loadRegistry();
  const sourceIds = [...new Set([...estimates.flatMap((e) => e.sourceIds), ...events.map((e) => e.source_id), ...liftObs.map((o) => o.source_id)])];
  return { c, bookings, delivery, estimates, gross, reach, frequency, observed, lift, recon, otherLines, sourceIds, allowed: allowedUses(sourceIds, registry), registry };
}
