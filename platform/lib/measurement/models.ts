/**
 * Format-specific exposure models. Each function is pure: given traced inputs it returns an
 * Estimate with low/base/high values, the formula text, every input, and warnings.
 *
 * Vocabulary (see docs/METHODOLOGY.md):
 *   venue visits         - people entering the venue in the period (input; never an impression)
 *   opportunity to see   - visits whose path enters the asset's viewing zone (visits x p_in_view_zone)
 *   ad contacts (OTS)    - for digital: times a person is in the zone while THIS ad plays
 *   estimated impressions- ad contacts x p_notice (only when a notice/attention factor is supplied)
 *   verified ad plays    - proof-of-play rows from the CMS (observed)
 * Reach / frequency are NOT produced here; see reach.ts.
 */
import { checkInputs, doubleCountViolations, smallSampleWarnings, staleWarnings } from "./validate";
import { Estimate, ModelInput, SCENARIOS, SCENARIO_NOTE, Scenario, scenarioValue, trace, unavailable } from "./types";

export const MODEL_VERSION = 1;

interface Ctx {
  asOfDate: string;       // date the estimate is computed for (used for staleness)
  maxInputAgeDays?: number;
}

function finalize(metric: string, unit: string, formula: string, inputs: ModelInput[], compute: (s: Scenario) => number, ctx: Ctx, extraWarnings: string[] = []): Estimate {
  const values = { low: 0, base: 0, high: 0 } as Record<Scenario, number>;
  for (const s of SCENARIOS) values[s] = compute(s);
  // Models are monotone non-decreasing in every input, so all-low <= all-base <= all-high must hold.
  if (!(values.low <= values.base && values.base <= values.high)) {
    throw new Error(`${metric}: scenario ordering violated (${values.low}, ${values.base}, ${values.high})`);
  }
  return {
    metric,
    metricVersion: MODEL_VERSION,
    unit,
    status: "internally_modeled",
    values,
    formula,
    inputs: inputs.map(trace),
    warnings: [...extraWarnings, ...staleWarnings(inputs, ctx.asOfDate, ctx.maxInputAgeDays ?? 730), ...smallSampleWarnings(inputs)],
    scenarioNote: SCENARIO_NOTE,
  };
}

const v = (i: ModelInput | undefined | null, s: Scenario, dflt = 1) => (i ? scenarioValue(i, s) : dflt);
const present = (...xs: (ModelInput | null | undefined)[]) => xs.filter((x): x is ModelInput => !!x);

// ---------------------------------------------------------------------------
// Digital screens (C-store, hotel lobby, mall food court, grocery screens)
// ---------------------------------------------------------------------------
export interface ScreenInputs {
  venue_visits: ModelInput;              // visits during the screen's operating window, for the period
  operating_seconds: ModelInput;         // seconds the screen was scheduled ON in the period
  dwell_seconds: ModelInput;             // mean time a visitor spends within the viewing zone
  p_in_view_zone: ModelInput;            // share of visits whose path enters the viewing zone
  loop_length_seconds: ModelInput;
  spot_length_seconds: ModelInput;
  ad_spots_per_loop: ModelInput;         // how many times THIS ad appears per loop
  verified_plays?: ModelInput | null;    // proof-of-play count for this ad in the period (observed)
  uptime_share?: ModelInput | null;      // used only when verified_plays is absent
  p_notice?: ModelInput | null;          // optional attention/notice factor
}

/**
 * Plays-based (Little's-law) exposure model.
 *   arrival_rate      = venue_visits / operating_seconds                      [visits per second]
 *   plays             = verified_plays  OR  operating_seconds / loop_length x ad_spots_per_loop x uptime
 *   audience_per_play = arrival_rate x (dwell + spot_length) x p_in_view_zone [people in zone during a play]
 *   ad_contacts       = plays x audience_per_play
 *   impressions       = ad_contacts x p_notice  (only if p_notice supplied; otherwise impressions = ad_contacts and labelled OTS)
 * A visitor whose dwell spans several loops is counted once per play seen: that is within-visit
 * frequency, which is why contacts must never be reported as people reached.
 */
export function screenAdContacts(inp: ScreenInputs, ctx: Ctx): Estimate {
  const formula =
    "contacts = plays x (venue_visits / operating_seconds) x (dwell_seconds + spot_length_seconds) x p_in_view_zone" +
    (inp.p_notice ? " x p_notice" : "") +
    "; plays = verified_plays if available else operating_seconds / loop_length_seconds x ad_spots_per_loop x uptime_share";
  const metric = inp.p_notice ? "est_impressions" : "ad_contacts_ots";
  const all = present(inp.venue_visits, inp.operating_seconds, inp.dwell_seconds, inp.p_in_view_zone, inp.loop_length_seconds, inp.spot_length_seconds, inp.ad_spots_per_loop, inp.verified_plays, inp.uptime_share, inp.p_notice);
  const reason = checkInputs(inp as unknown as Record<string, ModelInput>, [
    { code: "venue_visits", kind: "count" },
    { code: "operating_seconds", kind: "seconds" },
    { code: "dwell_seconds", kind: "seconds" },
    { code: "p_in_view_zone", kind: "probability" },
    { code: "loop_length_seconds", kind: "seconds" },
    { code: "spot_length_seconds", kind: "seconds" },
    { code: "ad_spots_per_loop", kind: "count" },
    { code: "verified_plays", kind: "count", optional: true },
    { code: "uptime_share", kind: "probability", optional: true },
    { code: "p_notice", kind: "probability", optional: true },
  ]);
  if (reason) return unavailable(metric, MODEL_VERSION, "contacts", formula, reason, all);

  const dc = doubleCountViolations(all, [...(inp.p_notice ? ["notice"] : []), "view_zone"]);
  if (dc.length) return unavailable(metric, MODEL_VERSION, "contacts", formula, dc.join("; "), all);

  const warnings: string[] = [];
  if (!inp.verified_plays) {
    warnings.push("Plays are SCHEDULED (loop math), not verified proof-of-play.");
  }
  if (inp.verified_plays && inp.uptime_share) warnings.push("uptime_share ignored because verified plays were supplied.");
  for (const s of SCENARIOS) {
    if (v(inp.spot_length_seconds, s) > v(inp.loop_length_seconds, s)) {
      return unavailable(metric, MODEL_VERSION, "contacts", formula, "spot_length_seconds exceeds loop_length_seconds", all);
    }
  }
  if (!inp.p_notice) warnings.push("No notice/attention factor applied: figure is opportunity-to-see contacts, not attention-adjusted impressions.");

  return finalize(metric, "contacts", formula, all, (s) => {
    const opSec = v(inp.operating_seconds, s);
    const plays = inp.verified_plays
      ? v(inp.verified_plays, s)
      : (opSec / v(inp.loop_length_seconds, s)) * v(inp.ad_spots_per_loop, s) * v(inp.uptime_share, s, 1);
    const arrival = v(inp.venue_visits, s) / opSec;
    const perPlay = arrival * (v(inp.dwell_seconds, s) + v(inp.spot_length_seconds, s)) * v(inp.p_in_view_zone, s);
    return plays * perPlay * v(inp.p_notice, s, 1);
  }, ctx, warnings);
}

/** Opportunity to see (people-visits, not contacts): visits x p_in_view_zone. */
export function opportunityToSee(visits: ModelInput, pInViewZone: ModelInput, ctx: Ctx): Estimate {
  const formula = "ots_visits = venue_visits x p_in_view_zone";
  const all = [visits, pInViewZone];
  const reason = checkInputs({ visits, pInViewZone } as unknown as Record<string, ModelInput>, [
    { code: "visits", kind: "count" },
    { code: "pInViewZone", kind: "probability" },
  ]);
  if (reason) return unavailable("ots_visits", MODEL_VERSION, "visits", formula, reason, all);
  const dc = doubleCountViolations(all, ["view_zone"]);
  if (dc.length) return unavailable("ots_visits", MODEL_VERSION, "visits", formula, dc.join("; "), all);
  return finalize("ots_visits", "visits", formula, all, (s) => v(visits, s) * v(pInViewZone, s), ctx);
}

// ---------------------------------------------------------------------------
// Pump tops (static)
// ---------------------------------------------------------------------------
export interface PumpTopInputs {
  fueling_transactions: ModelInput;     // fueling transactions at the station in the period
  fueling_positions: ModelInput;        // total fueling positions at the station
  positions_covered: ModelInput;        // positions from which THIS topper face is viewable
  viewers_per_transaction: ModelInput;  // people at the pump who can see the topper (driver + exiting passengers)
  p_notice?: ModelInput | null;
}

/** contacts = fueling_transactions x (positions_covered / fueling_positions) x viewers_per_transaction [x p_notice] */
export function pumpTopContacts(inp: PumpTopInputs, ctx: Ctx): Estimate {
  const formula = "contacts = fueling_transactions x (positions_covered / fueling_positions) x viewers_per_transaction" + (inp.p_notice ? " x p_notice" : "");
  const metric = inp.p_notice ? "est_impressions" : "ad_contacts_ots";
  const all = present(inp.fueling_transactions, inp.fueling_positions, inp.positions_covered, inp.viewers_per_transaction, inp.p_notice);
  const reason = checkInputs(inp as unknown as Record<string, ModelInput>, [
    { code: "fueling_transactions", kind: "count" },
    { code: "fueling_positions", kind: "positive" },
    { code: "positions_covered", kind: "count" },
    { code: "viewers_per_transaction", kind: "count" },
    { code: "p_notice", kind: "probability", optional: true },
  ]);
  if (reason) return unavailable(metric, MODEL_VERSION, "contacts", formula, reason, all);
  for (const s of SCENARIOS) {
    if (v(inp.positions_covered, s) > v(inp.fueling_positions, s)) {
      return unavailable(metric, MODEL_VERSION, "contacts", formula, "positions_covered exceeds fueling_positions", all);
    }
  }
  const warnings = ["Assumes transactions are spread evenly across fueling positions."];
  return finalize(metric, "contacts", formula, all, (s) =>
    v(inp.fueling_transactions, s) * (v(inp.positions_covered, s) / v(inp.fueling_positions, s)) * v(inp.viewers_per_transaction, s) * v(inp.p_notice, s, 1), ctx, warnings);
}

// ---------------------------------------------------------------------------
// Grocery checkout (counters, dividers, end caps)
// ---------------------------------------------------------------------------
export interface CheckoutInputs {
  transactions: ModelInput;             // store register transactions in the period, during operating hours
  lane_share: ModelInput;               // share of transactions going through lanes carrying the media
  shoppers_per_transaction: ModelInput; // people at the lane per transaction
  p_notice?: ModelInput | null;
}

/** contacts = transactions x lane_share x shoppers_per_transaction [x p_notice] */
export function checkoutContacts(inp: CheckoutInputs, ctx: Ctx): Estimate {
  const formula = "contacts = transactions x lane_share x shoppers_per_transaction" + (inp.p_notice ? " x p_notice" : "");
  const metric = inp.p_notice ? "est_impressions" : "ad_contacts_ots";
  const all = present(inp.transactions, inp.lane_share, inp.shoppers_per_transaction, inp.p_notice);
  const reason = checkInputs(inp as unknown as Record<string, ModelInput>, [
    { code: "transactions", kind: "count" },
    { code: "lane_share", kind: "probability" },
    { code: "shoppers_per_transaction", kind: "count" },
    { code: "p_notice", kind: "probability", optional: true },
  ]);
  if (reason) return unavailable(metric, MODEL_VERSION, "contacts", formula, reason, all);
  return finalize(metric, "contacts", formula, all, (s) =>
    v(inp.transactions, s) * v(inp.lane_share, s) * v(inp.shoppers_per_transaction, s) * v(inp.p_notice, s, 1), ctx);
}

// ---------------------------------------------------------------------------
// Walls / pillars / banners (static, roadside or in-center)
// ---------------------------------------------------------------------------
export interface StaticFaceInputs {
  pedestrians_passing?: ModelInput | null;   // pedestrians passing within the visibility zone in the period
  vehicles_passing?: ModelInput | null;      // vehicles passing in the facing direction in the period
  vehicle_occupancy?: ModelInput | null;
  p_visible_pedestrian?: ModelInput | null;  // share of passers for whom the face is in field of view
  p_visible_vehicle?: ModelInput | null;
  p_notice?: ModelInput | null;
}

/** contacts = (pedestrians x p_visible_ped + vehicles x occupancy x p_visible_veh) [x p_notice] */
export function staticFaceContacts(inp: StaticFaceInputs, ctx: Ctx): Estimate {
  const formula = "contacts = pedestrians_passing x p_visible_pedestrian + vehicles_passing x vehicle_occupancy x p_visible_vehicle" + (inp.p_notice ? " (sum) x p_notice" : "");
  const metric = inp.p_notice ? "est_impressions" : "ad_contacts_ots";
  const all = present(inp.pedestrians_passing, inp.vehicles_passing, inp.vehicle_occupancy, inp.p_visible_pedestrian, inp.p_visible_vehicle, inp.p_notice);
  const hasPed = !!inp.pedestrians_passing;
  const hasVeh = !!inp.vehicles_passing;
  if (!hasPed && !hasVeh) return unavailable(metric, MODEL_VERSION, "contacts", formula, "No pedestrian or vehicle traffic count for this face", all);
  const reason = checkInputs(inp as unknown as Record<string, ModelInput>, [
    { code: "pedestrians_passing", kind: "count", optional: true },
    { code: "p_visible_pedestrian", kind: "probability", optional: !hasPed },
    { code: "vehicles_passing", kind: "count", optional: true },
    { code: "vehicle_occupancy", kind: "count", optional: !hasVeh },
    { code: "p_visible_vehicle", kind: "probability", optional: !hasVeh },
    { code: "p_notice", kind: "probability", optional: true },
  ]);
  if (reason) return unavailable(metric, MODEL_VERSION, "contacts", formula, reason, all);
  const warnings: string[] = [];
  if (!hasPed) warnings.push("Pedestrian traffic unavailable; vehicle audience only.");
  if (!hasVeh) warnings.push("Vehicle traffic unavailable; pedestrian audience only.");
  return finalize(metric, "contacts", formula, all, (s) => {
    const ped = hasPed ? v(inp.pedestrians_passing, s) * v(inp.p_visible_pedestrian, s) : 0;
    const veh = hasVeh ? v(inp.vehicles_passing, s) * v(inp.vehicle_occupancy, s) * v(inp.p_visible_vehicle, s) : 0;
    return (ped + veh) * v(inp.p_notice, s, 1);
  }, ctx, warnings);
}

// ---------------------------------------------------------------------------
// Vehicles / vans (mobile)
// ---------------------------------------------------------------------------
export interface RouteSegmentExposure {
  segmentId: string;
  seconds_on_segment: number;          // from GPS, observed
  gps_source: string;                  // source_dataset id of the telematics feed
  vehicles_per_hour: ModelInput;       // opposing + same-direction traffic able to see the van on this segment
  pedestrians_per_hour?: ModelInput | null;
}

export interface VehicleInputs {
  segments: RouteSegmentExposure[];
  vehicle_occupancy: ModelInput;
  p_visible: ModelInput;               // share of passing people for whom a van side is in view
  p_notice?: ModelInput | null;
}

/**
 * Requires actual GPS route data. contacts = sum_segments (seconds/3600) x (vehicles_per_hour x occupancy + pedestrians_per_hour) x p_visible [x p_notice]
 * Uses traffic flow passing the van while it is on the segment (moving-observer approximation).
 */
export function vehicleContacts(inp: VehicleInputs, ctx: Ctx): Estimate {
  const formula = "contacts = SUM_segments (seconds_on_segment / 3600) x (vehicles_per_hour x vehicle_occupancy + pedestrians_per_hour) x p_visible" + (inp.p_notice ? " x p_notice" : "");
  const metric = inp.p_notice ? "est_impressions" : "ad_contacts_ots";
  const shared = present(inp.vehicle_occupancy, inp.p_visible, inp.p_notice);
  if (!inp.segments.length) {
    return unavailable(metric, MODEL_VERSION, "contacts", formula, "No GPS route segments with timestamps supplied; vehicle exposure cannot be estimated without actual routes.", shared);
  }
  const segInputs = inp.segments.flatMap((sg) => present(sg.vehicles_per_hour, sg.pedestrians_per_hour));
  const reason = checkInputs({ vehicle_occupancy: inp.vehicle_occupancy, p_visible: inp.p_visible, p_notice: inp.p_notice } as Record<string, ModelInput>, [
    { code: "vehicle_occupancy", kind: "count" },
    { code: "p_visible", kind: "probability" },
    { code: "p_notice", kind: "probability", optional: true },
  ]);
  if (reason) return unavailable(metric, MODEL_VERSION, "contacts", formula, reason, shared);
  const all = [...shared, ...segInputs];
  return finalize(metric, "contacts", formula, all, (s) =>
    inp.segments.reduce((sum, sg) => {
      const hours = sg.seconds_on_segment / 3600;
      const people = v(sg.vehicles_per_hour, s) * v(inp.vehicle_occupancy, s) + (sg.pedestrians_per_hour ? v(sg.pedestrians_per_hour, s) : 0);
      return sum + hours * people * v(inp.p_visible, s) * v(inp.p_notice, s, 1);
    }, 0), ctx, ["Traffic volumes on segments are applied as hourly averages; time-of-day variation is not modeled unless hourly counts are supplied."]);
}

// ---------------------------------------------------------------------------
// Derived venue visits (hotel lobbies) when no direct count exists
// ---------------------------------------------------------------------------
export interface HotelVisitInputs {
  rooms: ModelInput;                       // venue-published room count
  occupancy_rate: ModelInput;              // DBEDT/HTA published occupancy for island/class & period
  guests_per_occupied_room: ModelInput;
  lobby_passes_per_guest_day: ModelInput;
  days: ModelInput;
}

/** lobby_visits = rooms x occupancy_rate x guests_per_occupied_room x lobby_passes_per_guest_day x days */
export function hotelLobbyVisits(inp: HotelVisitInputs, ctx: Ctx): Estimate {
  const formula = "lobby_visits = rooms x occupancy_rate x guests_per_occupied_room x lobby_passes_per_guest_day x days";
  const all = present(inp.rooms, inp.occupancy_rate, inp.guests_per_occupied_room, inp.lobby_passes_per_guest_day, inp.days);
  const reason = checkInputs(inp as unknown as Record<string, ModelInput>, [
    { code: "rooms", kind: "count" },
    { code: "occupancy_rate", kind: "probability" },
    { code: "guests_per_occupied_room", kind: "count" },
    { code: "lobby_passes_per_guest_day", kind: "count" },
    { code: "days", kind: "positive" },
  ]);
  if (reason) return unavailable("venue_visits", MODEL_VERSION, "visits", formula, reason, all);
  return finalize("venue_visits", "visits", formula, all, (s) =>
    v(inp.rooms, s) * v(inp.occupancy_rate, s) * v(inp.guests_per_occupied_room, s) * v(inp.lobby_passes_per_guest_day, s) * v(inp.days, s), ctx,
    ["Derived visits: counts guest lobby passes only; non-guest visitors (restaurants, events) are excluded unless counted separately."]);
}

/** Adds gross contacts across assets. Gross contacts ARE additive; people reached are NOT (see reach.ts). */
export function sumContacts(estimates: Estimate[], label = "network gross contacts"): Estimate {
  const formula = "gross_contacts = SUM(asset contacts)  (duplicated people counted once per contact)";
  const ADDITIVE = new Set(["ad_contacts_ots", "est_impressions"]);
  const notAdditive = estimates.filter((e) => e.values && !ADDITIVE.has(e.metric));
  const avail = estimates.filter((e) => e.values && ADDITIVE.has(e.metric));
  const missing = estimates.length - avail.length - notAdditive.length;
  if (!avail.length) {
    return { ...unavailable("gross_contacts", MODEL_VERSION, "contacts", formula, notAdditive.length ? "Only opportunity-to-see visit estimates are available; these cannot be summed across screens." : "No asset in the selection has an available estimate"), inputs: [] };
  }
  const values = { low: 0, base: 0, high: 0 } as Record<Scenario, number>;
  for (const e of avail) for (const s of SCENARIOS) values[s] += e.values![s];
  const warnings = [...new Set(avail.flatMap((e) => e.warnings))];
  if (missing) warnings.unshift(`PARTIAL: ${missing} of ${estimates.length} assets have no estimate and are excluded from the ${label} (not counted as zero).`);
  if (notAdditive.length) warnings.unshift(`EXCLUDED: ${notAdditive.length} asset(s) have only opportunity-to-see visit estimates, which are not additive across screens (the same visitor passes several screens).`);
  const units = new Set(avail.map((e) => e.metric));
  if (units.size > 1) warnings.unshift("MIXED METRICS: some assets are attention-adjusted impressions and others are OTS contacts; the total mixes both.");
  return {
    metric: "gross_contacts",
    metricVersion: MODEL_VERSION,
    unit: "contacts",
    status: "internally_modeled",
    values,
    formula,
    inputs: avail.flatMap((e) => e.inputs),
    warnings,
    scenarioNote: SCENARIO_NOTE,
  };
}
