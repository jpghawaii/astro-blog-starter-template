/**
 * Unique reach and frequency.
 *
 * Summing venue audiences double-counts people who visit several venues (or one venue many
 * times). Deduplicated reach therefore requires either:
 *   (a) a licensed overlap / unique-visitor dataset for exactly the venue set and period, or
 *   (b) a documented internal model that has been reviewed and registered.
 * Without one of those, reach and frequency are reported as UNAVAILABLE.
 */
import { Estimate, ModelInput, SCENARIO_NOTE, unavailable, trace } from "./types";

export interface OverlapSource {
  /** Unique people across the selected venues in the period, from a licensed dataset. */
  unique_people: ModelInput;
  /** The venue ids the vendor deduplicated across. Must cover the selection exactly. */
  coveredVenueIds: string[];
  /** Licensed source must permit the intended use; checked by caller via licensing.ts. */
  method: string;
}

export function uniqueReach(selectedVenueIds: string[], grossContacts: Estimate, overlap?: OverlapSource | null): { reach: Estimate; frequency: Estimate } {
  const reachFormula = "reach = vendor-deduplicated unique people across the exact venue set and period";
  const freqFormula = "average_frequency = gross_contacts / reach";
  if (!overlap) {
    const reason = "No licensed overlap or unique-visitor data for this venue set. Venue audiences cannot be summed into unique reach.";
    return {
      reach: unavailable("unique_reach", 1, "people", reachFormula, reason),
      frequency: unavailable("avg_frequency", 1, "contacts per person", freqFormula, reason),
    };
  }
  const want = new Set(selectedVenueIds);
  const have = new Set(overlap.coveredVenueIds);
  const sameSet = want.size === have.size && [...want].every((v) => have.has(v));
  if (!sameSet) {
    const reason = "Overlap data covers a different venue set than the selection; deduplicated reach would be extrapolated.";
    return {
      reach: unavailable("unique_reach", 1, "people", reachFormula, reason, [overlap.unique_people]),
      frequency: unavailable("avg_frequency", 1, "contacts per person", freqFormula, reason),
    };
  }
  const u = overlap.unique_people;
  const uv = typeof u.value === "number" ? { low: u.value, base: u.value, high: u.value } : u.value;
  const reach: Estimate = {
    metric: "unique_reach",
    metricVersion: 1,
    unit: "people",
    status: u.status === "observed" ? "observed" : "vendor_modeled",
    values: uv,
    formula: `${reachFormula} (${overlap.method})`,
    inputs: [trace(u)],
    warnings: ["Reach is the vendor's unique visitors to the venues, i.e. people with an opportunity to see, not people who noticed the ad."],
    scenarioNote: SCENARIO_NOTE,
  };
  if (!grossContacts.values) {
    return { reach, frequency: unavailable("avg_frequency", 1, "contacts per person", freqFormula, "Gross contacts unavailable") };
  }
  // Frequency = contacts / reach. Pair low contacts with HIGH reach for the low end (and vice versa)
  // so the scenario range is honest about both sources of uncertainty.
  const g = grossContacts.values;
  const frequency: Estimate = {
    metric: "avg_frequency",
    metricVersion: 1,
    unit: "contacts per person",
    status: "internally_modeled",
    values: { low: g.low / uv.high, base: g.base / uv.base, high: g.high / uv.low },
    formula: freqFormula,
    inputs: [...grossContacts.inputs, trace(u)],
    warnings: ["Frequency combines an internal contact model with vendor reach; definitions must refer to the same period and venues."],
    scenarioNote: SCENARIO_NOTE,
  };
  return { reach, frequency };
}
