/**
 * Campaign outcomes. Three tiers, never blended:
 *   observed     - events recorded in a system during the flight + window (QR scans, UTM sessions...)
 *   attributed   - events credited to the campaign by an explicit rule (window + matching method)
 *   incremental  - causal lift; ONLY from a declared experimental / quasi-experimental design with a control
 */

export type EventType = "qr_scan" | "utm_visit" | "lead" | "purchase" | "coupon_redemption" | "store_visit";

export interface ConversionEvent {
  id: string;
  sourceId: string;
  eventType: EventType;
  occurredAt: string; // ISO timestamp
  valueUsd?: number | null;
  dedupKey?: string | null;
  campaignTagged: boolean; // event carries campaign-specific identifier (QR id, utm_campaign, coupon code)
}

export interface CampaignWindow { flightStart: string; flightEnd: string; windowDays: number }

export interface ObservedSummary {
  bySourceAndType: { sourceId: string; eventType: EventType; count: number; valueUsd: number | null }[];
  /** Cross-system total, only when every counted event has a dedup key. */
  crossSystemTotal: { eventType: EventType; uniqueCount: number | null; reason?: string }[];
  outsideWindow: number;
  untagged: number;
  salesDeduplicated: { uniqueCount: number | null; reason: string } | null;
}

const ms = (iso: string) => Date.parse(iso.length === 10 ? iso + "T00:00:00Z" : iso);

export function inWindow(e: ConversionEvent, w: CampaignWindow): boolean {
  const t = ms(e.occurredAt);
  return t >= ms(w.flightStart) && t < ms(w.flightEnd) + (1 + w.windowDays) * 86_400_000;
}

export function summarizeObserved(events: ConversionEvent[], w: CampaignWindow): ObservedSummary {
  const counted = events.filter((e) => e.campaignTagged && inWindow(e, w));
  const outsideWindow = events.filter((e) => e.campaignTagged && !inWindow(e, w)).length;
  const untagged = events.filter((e) => !e.campaignTagged).length;

  const groups = new Map<string, { sourceId: string; eventType: EventType; count: number; valueUsd: number | null }>();
  for (const e of counted) {
    const k = `${e.sourceId}|${e.eventType}`;
    const g = groups.get(k) ?? { sourceId: e.sourceId, eventType: e.eventType, count: 0, valueUsd: null };
    g.count++;
    if (e.valueUsd != null) g.valueUsd = (g.valueUsd ?? 0) + e.valueUsd;
    groups.set(k, g);
  }

  const types = [...new Set(counted.map((e) => e.eventType))];
  const crossSystemTotal = types.map((t) => {
    const evs = counted.filter((e) => e.eventType === t);
    const systems = new Set(evs.map((e) => e.sourceId));
    if (systems.size === 1) return { eventType: t, uniqueCount: evs.length };
    if (evs.some((e) => !e.dedupKey)) {
      return { eventType: t, uniqueCount: null, reason: `Reported by ${systems.size} systems and some events lack a dedup key; totals are shown per system only.` };
    }
    return { eventType: t, uniqueCount: new Set(evs.map((e) => e.dedupKey)).size };
  });

  // Sales are reported under different event types by different systems (POS coupon redemption vs
  // web-analytics purchase). Combine them only through a shared dedup key.
  const sales = counted.filter((e) => e.eventType === "purchase" || e.eventType === "coupon_redemption");
  let salesDeduplicated: ObservedSummary["salesDeduplicated"] = null;
  if (new Set(sales.map((e) => e.eventType)).size > 1) {
    salesDeduplicated = sales.some((e) => !e.dedupKey)
      ? { uniqueCount: null, reason: "Purchases and coupon redemptions come from different systems and some lack an order/coupon key; they are not added together." }
      : { uniqueCount: new Set(sales.map((e) => e.dedupKey)).size, reason: "Unique sales across systems, deduplicated by order/coupon key." };
  }
  return { bySourceAndType: [...groups.values()], crossSystemTotal, outsideWindow, untagged, salesDeduplicated };
}

// ---------------------------------------------------------------------------
// Incremental lift (difference-in-differences) — only with a declared design.
// ---------------------------------------------------------------------------
export type Design = "none" | "geo_holdout" | "matched_market" | "randomized_venue" | "pre_post_only";

export interface GroupPeriods { pre: number; post: number; preDays: number; postDays: number; units: number }

export interface LiftResult {
  available: boolean;
  reason?: string;
  design: Design;
  testRateChange?: number;
  controlRateChange?: number;
  incrementalPerUnitPerDay?: number;
  incrementalTotal?: number;
  relativeLift?: number | null;
  limitations: string[];
}

/**
 * DiD on per-unit-per-day rates:
 *   delta_test    = post_test/(units*days) - pre_test/(units*days)
 *   delta_control = same for control
 *   incremental   = (delta_test - delta_control) x test_units x post_days
 * No significance test is reported unless enough units exist; with few geos it is descriptive only.
 */
export function differenceInDifferences(design: Design, test: GroupPeriods, control: GroupPeriods | null): LiftResult {
  const limitations: string[] = [];
  if (design === "none" || design === "pre_post_only") {
    return { available: false, design, reason: "No control group was designed for this campaign, so incremental lift cannot be claimed. Report observed and attributed results only.", limitations };
  }
  if (!control) return { available: false, design, reason: "Design declares a control, but no control data was supplied.", limitations };
  for (const [n, g] of [["test", test], ["control", control]] as const) {
    if (g.units <= 0 || g.preDays <= 0 || g.postDays <= 0) return { available: false, design, reason: `${n} group has zero units or days`, limitations };
  }
  const rate = (x: number, g: GroupPeriods, days: number) => x / (g.units * days);
  const dT = rate(test.post, test, test.postDays) - rate(test.pre, test, test.preDays);
  const dC = rate(control.post, control, control.postDays) - rate(control.pre, control, control.preDays);
  const perUnitDay = dT - dC;
  const total = perUnitDay * test.units * test.postDays;
  const baseline = rate(test.pre, test, test.preDays) + dC; // counterfactual post rate
  if (test.units + control.units < 10) limitations.push(`Only ${test.units + control.units} units in the design; no statistical significance is claimed.`);
  if (design === "matched_market") limitations.push("Matched-market design: relies on the parallel-trends assumption between test and control areas.");
  if (design === "geo_holdout") limitations.push("Geo holdout: spillover between nearby test and control areas would bias lift toward zero.");
  return {
    available: true,
    design,
    testRateChange: dT,
    controlRateChange: dC,
    incrementalPerUnitPerDay: perUnitDay,
    incrementalTotal: total,
    relativeLift: baseline > 0 ? perUnitDay / baseline : null,
    limitations,
  };
}
