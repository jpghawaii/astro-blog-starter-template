import { describe, expect, it } from "vitest";
import { checkoutContacts, hotelLobbyVisits, opportunityToSee, pumpTopContacts, screenAdContacts, staticFaceContacts, sumContacts, vehicleContacts } from "../lib/measurement/models";
import { uniqueReach } from "../lib/measurement/reach";
import { ModelInput } from "../lib/measurement/types";

const ctx = { asOfDate: "2026-11-26" };
const obs = (code: string, value: number, extra: Partial<ModelInput> = {}): ModelInput => ({ code, label: code, unit: "x", status: "observed", value, sourceId: "test_obs", asOf: "2026-10-31", ...extra });
const asm = (code: string, low: number, base: number, high: number): ModelInput => ({ code, label: code, unit: "x", status: "assumed", value: { low, base, high }, sourceId: "jpg_assumptions" });

describe("screen ad contacts (plays-based Little's law)", () => {
  // 28 days x 16h operating = 1,612,800 s; 20,000 visits -> arrival rate 0.0124/s
  const base = {
    venue_visits: obs("venue_visits", 20_000),
    operating_seconds: obs("operating_seconds", 28 * 16 * 3600),
    dwell_seconds: asm("dwell_seconds", 20, 30, 45),
    p_in_view_zone: asm("p_in_view_zone", 0.5, 0.7, 0.9),
    loop_length_seconds: obs("loop_length_seconds", 120),
    spot_length_seconds: obs("spot_length_seconds", 15),
    ad_spots_per_loop: obs("ad_spots_per_loop", 1),
  };

  it("computes scheduled-play contacts with hand-checked arithmetic", () => {
    const e = screenAdContacts({ ...base, uptime_share: obs("uptime_share", 1) }, ctx);
    expect(e.status).toBe("internally_modeled");
    const opSec = 28 * 16 * 3600;
    const plays = opSec / 120; // 13,440
    const perPlay = (20_000 / opSec) * (30 + 15) * 0.7;
    expect(e.values!.base).toBeCloseTo(plays * perPlay, 6);
    // Algebraic simplification: visits x (dwell+spot)/loop x p = 20,000 x 45/120 x 0.7 = 5,250
    expect(e.values!.base).toBeCloseTo(5250, 6);
    expect(e.values!.low).toBeCloseTo(20_000 * (35 / 120) * 0.5, 6);
    expect(e.values!.high).toBeCloseTo(20_000 * (60 / 120) * 0.9, 6);
    expect(e.metric).toBe("ad_contacts_ots");
    expect(e.warnings.join(" ")).toMatch(/SCHEDULED/);
  });

  it("uses verified proof-of-play counts instead of loop math when supplied", () => {
    const e = screenAdContacts({ ...base, verified_plays: obs("verified_plays", 10_000), uptime_share: obs("uptime_share", 0.5) }, ctx);
    const opSec = 28 * 16 * 3600;
    expect(e.values!.base).toBeCloseTo(10_000 * (20_000 / opSec) * 45 * 0.7, 6);
    expect(e.warnings.join(" ")).not.toMatch(/SCHEDULED/);
    expect(e.warnings.join(" ")).toMatch(/uptime_share ignored/);
  });

  it("never equates venue traffic with impressions: contacts are below visits when dwell+spot < loop", () => {
    const e = screenAdContacts(base, ctx);
    expect(e.values!.high).toBeLessThan(20_000);
  });

  it("labels as impressions only when a notice factor is supplied", () => {
    const e = screenAdContacts({ ...base, p_notice: asm("p_notice", 0.3, 0.4, 0.5) }, ctx);
    expect(e.metric).toBe("est_impressions");
    expect(e.values!.base).toBeCloseTo(5250 * 0.4, 6);
  });

  it("returns unavailable (not zero) when visits are missing", () => {
    const { venue_visits, ...rest } = base;
    void venue_visits;
    const e = screenAdContacts(rest as never, ctx);
    expect(e.status).toBe("unavailable");
    expect(e.values).toBeNull();
    expect(e.unavailableReason).toMatch(/venue_visits/);
  });

  it("blocks double counting when visits already include view-zone adjustment", () => {
    const e = screenAdContacts({ ...base, venue_visits: obs("venue_visits", 20_000, { alreadyAdjustedFor: ["view_zone"] }) }, ctx);
    expect(e.status).toBe("unavailable");
    expect(e.unavailableReason).toMatch(/double-counted/);
  });

  it("rejects probabilities above 1 and misordered scenarios", () => {
    expect(screenAdContacts({ ...base, p_in_view_zone: obs("p_in_view_zone", 1.2) }, ctx).status).toBe("unavailable");
    expect(screenAdContacts({ ...base, dwell_seconds: asm("dwell_seconds", 40, 30, 50) }, ctx).unavailableReason).toMatch(/low <= base <= high/);
  });

  it("flags stale and small-sample inputs", () => {
    const e = screenAdContacts({ ...base, venue_visits: obs("venue_visits", 20_000, { asOf: "2022-01-01", sampleSize: 12 }) }, ctx);
    expect(e.warnings.some((w) => w.startsWith("STALE"))).toBe(true);
    expect(e.warnings.some((w) => w.startsWith("SMALL SAMPLE"))).toBe(true);
  });

  it("refuses a spot longer than the loop", () => {
    expect(screenAdContacts({ ...base, spot_length_seconds: obs("spot_length_seconds", 200) }, ctx).status).toBe("unavailable");
  });
});

describe("opportunity to see", () => {
  it("is visits x view-zone share", () => {
    const e = opportunityToSee(obs("venue_visits", 1000), asm("p", 0.4, 0.5, 0.6), ctx);
    expect(e.values).toEqual({ low: 400, base: 500, high: 600 });
  });
});

describe("pump tops", () => {
  it("allocates station transactions by position share", () => {
    const e = pumpTopContacts({
      fueling_transactions: obs("fueling_transactions", 12_000),
      fueling_positions: obs("fueling_positions", 8),
      positions_covered: obs("positions_covered", 2),
      viewers_per_transaction: asm("viewers", 1, 1.1, 1.3),
    }, ctx);
    expect(e.values!.base).toBeCloseTo(12_000 * (2 / 8) * 1.1, 6);
    expect(e.values!.low).toBeCloseTo(3000, 6);
  });
  it("rejects covered positions above station positions", () => {
    const e = pumpTopContacts({ fueling_transactions: obs("t", 1), fueling_positions: obs("p", 4), positions_covered: obs("c", 6), viewers_per_transaction: obs("v", 1) }, ctx);
    expect(e.status).toBe("unavailable");
  });
});

describe("checkout", () => {
  it("transactions x lane share x shoppers", () => {
    const e = checkoutContacts({ transactions: obs("t", 50_000), lane_share: obs("l", 0.6), shoppers_per_transaction: asm("s", 1, 1.2, 1.4) }, ctx);
    expect(e.values!.base).toBeCloseTo(36_000, 6);
  });
});

describe("static faces", () => {
  it("sums pedestrian and vehicle audiences", () => {
    const e = staticFaceContacts({
      pedestrians_passing: obs("ped", 10_000), p_visible_pedestrian: asm("pp", 0.3, 0.4, 0.5),
      vehicles_passing: obs("veh", 20_000), vehicle_occupancy: obs("occ", 1.3), p_visible_vehicle: asm("pv", 0.2, 0.25, 0.3),
    }, ctx);
    expect(e.values!.base).toBeCloseTo(10_000 * 0.4 + 20_000 * 1.3 * 0.25, 6);
  });
  it("is unavailable without any traffic count", () => {
    expect(staticFaceContacts({ p_visible_pedestrian: obs("pp", 0.4) }, ctx).status).toBe("unavailable");
  });
});

describe("vehicles", () => {
  it("is unavailable without GPS routes", () => {
    const e = vehicleContacts({ segments: [], vehicle_occupancy: obs("o", 1.3), p_visible: asm("p", 0.2, 0.3, 0.4) }, ctx);
    expect(e.status).toBe("unavailable");
    expect(e.unavailableReason).toMatch(/GPS/);
  });
  it("sums segment exposure by time on segment", () => {
    const e = vehicleContacts({
      segments: [
        { segmentId: "a", seconds_on_segment: 1800, gps_source: "gps", vehicles_per_hour: obs("vph", 2000) },
        { segmentId: "b", seconds_on_segment: 3600, gps_source: "gps", vehicles_per_hour: obs("vph", 1000), pedestrians_per_hour: obs("pph", 100) },
      ],
      vehicle_occupancy: obs("o", 1.25), p_visible: obs("p", 0.4),
    }, ctx);
    expect(e.values!.base).toBeCloseTo((0.5 * 2000 * 1.25 + 1 * (1000 * 1.25 + 100)) * 0.4, 6);
  });
});

describe("hotel lobby derived visits", () => {
  it("multiplies published rooms by occupancy and assumptions", () => {
    const e = hotelLobbyVisits({ rooms: obs("rooms", 300), occupancy_rate: obs("occ", 0.8), guests_per_occupied_room: asm("g", 1.8, 2, 2.2), lobby_passes_per_guest_day: asm("lp", 1, 2, 3), days: obs("d", 28) }, ctx);
    expect(e.values!.base).toBeCloseTo(300 * 0.8 * 2 * 2 * 28, 6);
    expect(e.metric).toBe("venue_visits");
  });
});

describe("network totals and reach", () => {
  const a = screenAdContacts({ venue_visits: obs("v", 1000), operating_seconds: obs("o", 1000), dwell_seconds: obs("d", 30), p_in_view_zone: obs("p", 1), loop_length_seconds: obs("l", 60), spot_length_seconds: obs("s", 15), ad_spots_per_loop: obs("n", 1) }, ctx);
  const missing = screenAdContacts({} as never, ctx);

  it("sums gross contacts and reports excluded assets rather than treating them as zero", () => {
    const t = sumContacts([a, a, missing]);
    expect(t.values!.base).toBeCloseTo(2 * a.values!.base, 6);
    expect(t.warnings[0]).toMatch(/PARTIAL: 1 of 3/);
  });

  it("refuses to add opportunity-to-see visits across screens", () => {
    const ots = opportunityToSee(obs("v", 1000), obs("p", 0.5), ctx);
    const t = sumContacts([a, ots, ots]);
    expect(t.values!.base).toBeCloseTo(a.values!.base, 6);
    expect(t.warnings.join(" ")).toMatch(/not additive/);
    expect(sumContacts([ots]).status).toBe("unavailable");
  });

  it("marks unique reach and frequency unavailable without overlap data", () => {
    const t = sumContacts([a, a]);
    const r = uniqueReach(["1", "2"], t, null);
    expect(r.reach.status).toBe("unavailable");
    expect(r.frequency.status).toBe("unavailable");
  });

  it("refuses overlap data for a different venue set", () => {
    const t = sumContacts([a, a]);
    const r = uniqueReach(["1", "2"], t, { unique_people: obs("u", 500), coveredVenueIds: ["1", "3"], method: "vendor" });
    expect(r.reach.status).toBe("unavailable");
  });

  it("computes frequency from vendor reach with crossed scenario bounds", () => {
    const t = sumContacts([a, a]);
    const r = uniqueReach(["1", "2"], t, { unique_people: { ...asm("u", 400, 500, 600), status: "vendor_modeled", sourceId: "placer" }, coveredVenueIds: ["2", "1"], method: "Placer unique visitors" });
    expect(r.reach.status).toBe("vendor_modeled");
    expect(r.frequency.values!.base).toBeCloseTo(t.values!.base / 500, 6);
    expect(r.frequency.values!.low).toBeCloseTo(t.values!.low / 600, 6);
  });
});
