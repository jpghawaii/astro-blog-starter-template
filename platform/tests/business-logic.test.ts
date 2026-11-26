import { describe, expect, it } from "vitest";
import { occupancy } from "../lib/inventory/occupancy";
import { allowedUses, filterForUse, SourceLicense } from "../lib/licensing";
import { differenceInDifferences, summarizeObserved, ConversionEvent } from "../lib/outcomes";
import { matchRecord, nameSimilarity, normalizeName, reconcileRevenue } from "../lib/reconcile";

describe("occupancy", () => {
  const cap = [{ assetId: "a", start: "2026-11-01", end: "2026-11-30", unit: "spot_slot" as const, capacity: 6 }];
  it("weights bookings by days and slots", () => {
    const r = occupancy(["a"], cap, [
      { assetId: "a", start: "2026-11-01", end: "2026-11-14", unit: "spot_slot", units: 3, status: "confirmed" },
      { assetId: "a", start: "2026-11-15", end: "2026-11-30", unit: "spot_slot", units: 1, status: "hold" },
    ], { start: "2026-11-01", end: "2026-11-30" }, "spot_slot");
    expect(r.capacityUnitDays).toBe(180);
    expect(r.bookedUnitDays).toBe(42);
    expect(r.occupancy).toBeCloseTo(42 / 180, 9);
    expect(r.occupancyInclHolds).toBeCloseTo((42 + 16) / 180, 9);
  });
  it("is unavailable (null) when no capacity is defined, never 0%", () => {
    const r = occupancy(["b"], cap, [], { start: "2026-11-01", end: "2026-11-30" }, "spot_slot");
    expect(r.occupancy).toBeNull();
    expect(r.assetsWithoutCapacity).toEqual(["b"]);
  });
  it("caps and flags overbooking, ignores cancelled and other-unit rows", () => {
    const r = occupancy(["a"], cap, [
      { assetId: "a", start: "2026-11-01", end: "2026-11-01", unit: "spot_slot", units: 8, status: "confirmed" },
      { assetId: "a", start: "2026-11-02", end: "2026-11-02", unit: "spot_slot", units: 6, status: "cancelled" },
      { assetId: "a", start: "2026-11-02", end: "2026-11-02", unit: "face_period", units: 1, status: "confirmed" },
    ], { start: "2026-11-01", end: "2026-11-02" }, "spot_slot");
    expect(r.bookedUnitDays).toBe(6);
    expect(r.overbookedDays).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/different unit/);
  });
});

describe("license-based export restrictions", () => {
  const reg = new Map<string, SourceLicense>([
    ["census_lodes8", { id: "census_lodes8", name: "LODES", permits_internal_analysis: true, permits_client_reports: true, permits_audience_activation: true, permits_redistribution: true }],
    ["placer", { id: "placer", name: "Placer", permits_internal_analysis: true, permits_client_reports: null, permits_audience_activation: false, permits_redistribution: false }],
  ]);
  it("derived values inherit the most restrictive permission; unknown = not permitted", () => {
    expect(allowedUses(["census_lodes8"], reg)).toEqual(["internal", "client_report", "activation", "redistribution"]);
    expect(allowedUses(["census_lodes8", "placer"], reg)).toEqual(["internal"]);
    expect(allowedUses(["unregistered"], reg)).toEqual([]);
  });
  it("excludes restricted items from client exports and names the blocker", () => {
    const d = filterForUse([{ k: 1, sourceIds: ["census_lodes8"] }, { k: 2, sourceIds: ["census_lodes8", "placer"] }], "client_report", reg);
    expect(d.included.map((x) => x.k)).toEqual([1]);
    expect(d.excluded[0].blockingSources).toEqual(["placer"]);
  });
});

describe("outcomes", () => {
  const w = { flightStart: "2026-10-01", flightEnd: "2026-10-28", windowDays: 7 };
  const ev = (id: string, src: string, t: ConversionEvent["eventType"], at: string, dedupKey: string | null = null, tagged = true): ConversionEvent => ({ id, sourceId: src, eventType: t, occurredAt: at, dedupKey, campaignTagged: tagged });
  it("counts only tagged events inside flight + window", () => {
    const s = summarizeObserved([
      ev("1", "qr", "qr_scan", "2026-10-02T10:00:00Z"),
      ev("2", "qr", "qr_scan", "2026-11-04T23:00:00Z"), // last day of window
      ev("3", "qr", "qr_scan", "2026-11-05T01:00:00Z"), // outside
      ev("4", "qr", "qr_scan", "2026-10-03T01:00:00Z", null, false),
    ], w);
    expect(s.bySourceAndType[0].count).toBe(2);
    expect(s.outsideWindow).toBe(1);
    expect(s.untagged).toBe(1);
  });
  it("does not sum across systems without dedup keys", () => {
    const s = summarizeObserved([ev("1", "shopify", "purchase", "2026-10-02T00:00:00Z"), ev("2", "ga4", "purchase", "2026-10-02T00:00:00Z")], w);
    expect(s.crossSystemTotal[0].uniqueCount).toBeNull();
  });
  it("deduplicates across systems with dedup keys", () => {
    const s = summarizeObserved([ev("1", "shopify", "purchase", "2026-10-02T00:00:00Z", "o1"), ev("2", "ga4", "purchase", "2026-10-02T00:00:00Z", "o1"), ev("3", "ga4", "purchase", "2026-10-03T00:00:00Z", "o2")], w);
    expect(s.crossSystemTotal[0].uniqueCount).toBe(2);
  });
  it("deduplicates sales reported as different event types by different systems", () => {
    const s = summarizeObserved([
      ev("1", "pos", "coupon_redemption", "2026-10-02T00:00:00Z", "o1"), ev("2", "pos", "coupon_redemption", "2026-10-03T00:00:00Z", "o2"),
      ev("3", "ga4", "purchase", "2026-10-02T00:00:00Z", "o1"),
    ], w);
    expect(s.salesDeduplicated!.uniqueCount).toBe(2);
    const s2 = summarizeObserved([ev("1", "pos", "coupon_redemption", "2026-10-02T00:00:00Z", "o1"), ev("3", "ga4", "purchase", "2026-10-02T00:00:00Z")], w);
    expect(s2.salesDeduplicated!.uniqueCount).toBeNull();
  });

  it("refuses lift without a control design", () => {
    expect(differenceInDifferences("none", { pre: 1, post: 2, preDays: 1, postDays: 1, units: 1 }, null).available).toBe(false);
    expect(differenceInDifferences("pre_post_only", { pre: 1, post: 2, preDays: 1, postDays: 1, units: 1 }, null).available).toBe(false);
  });
  it("computes difference-in-differences", () => {
    // test: 4 stores, 28 days pre 1120 visits (10/store/day) -> post 1344 (12)
    // control: 4 stores, 1120 -> 1232 (11). Incremental = (2-1) x 4 x 28 = 112
    const r = differenceInDifferences("geo_holdout", { pre: 1120, post: 1344, preDays: 28, postDays: 28, units: 4 }, { pre: 1120, post: 1232, preDays: 28, postDays: 28, units: 4 });
    expect(r.available).toBe(true);
    expect(r.incrementalTotal).toBeCloseTo(112, 9);
    expect(r.relativeLift).toBeCloseTo(1 / 11, 9);
    expect(r.limitations.join(" ")).toMatch(/no statistical significance/);
  });
});

describe("reconciliation", () => {
  it("normalizes Hawaiian okina, abbreviations and stop words", () => {
    expect(normalizeName("Hawaiʻi Kai Towne Center")).toBe(normalizeName("Hawaii Kai Towne Center"));
    expect(normalizeName("AIM 10th Ave.")).toBe("aloha island mart 10th avenue");
  });
  it("auto-matches clear names, queues ambiguous ones", () => {
    const cands = [{ id: "1", name: "Aloha Island Mart 10th Avenue" }, { id: "2", name: "Aloha Island Mart King Street" }];
    expect(matchRecord("AIM 10th Ave", null, null, cands).decision).toBe("auto");
    const amb = matchRecord("Aloha Island Mart", null, null, cands);
    expect(amb.decision).not.toBe("auto");
    expect(nameSimilarity("Times Kailua", "Times Kaneohe")).toBeLessThan(0.92);
  });
  it("penalizes same-name chain stores far apart", () => {
    const d = matchRecord("Times Supermarket", 21.3, -157.8, [{ id: "1", name: "Times Supermarket", lat: 19.7, lon: -155.08 }]);
    expect(d.decision).not.toBe("auto");
  });
  it("reconciles invoices to booked value and keeps unlinked lines separate", () => {
    const r = reconcileRevenue(
      [{ campaignId: "c1", advertiser: "A", bookedValue: 2100, flightStart: "", flightEnd: "" }, { campaignId: "c2", advertiser: "B", bookedValue: 500, flightStart: "", flightEnd: "" }, { campaignId: "c3", advertiser: "C", bookedValue: null, flightStart: "", flightEnd: "" }],
      [{ id: "1", campaignId: "c1", customer: "A", amount: 2100, date: "" }, { id: "2", campaignId: "c2", customer: "B", amount: 250, date: "" }, { id: "3", campaignId: null, customer: "Z", amount: 99.99, date: "" }],
    );
    expect(r.rows.map((x) => x.flag)).toEqual(["ok", "under_invoiced", "no_booking_value"]);
    expect(r.unlinkedTotal).toBe(99.99);
  });
});
