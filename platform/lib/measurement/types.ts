/**
 * Shared types for measurement. Every number that enters or leaves a model carries
 * its provenance so a report value can be traced back to its source and formula.
 */

export type ValueStatus = "observed" | "vendor_modeled" | "internally_modeled" | "assumed" | "unavailable";
export type Scenario = "low" | "base" | "high";
export const SCENARIOS: Scenario[] = ["low", "base", "high"];

/** One input to a model. Uncertain inputs give low/base/high; certain inputs give a single value. */
export interface ModelInput {
  code: string;                 // e.g. 'venue_visits', 'dwell_seconds'
  label: string;
  unit: string;
  status: Exclude<ValueStatus, "unavailable">;
  /** Single value (observed) or scenario values (assumptions / vendor ranges). */
  value: number | { low: number; base: number; high: number };
  sourceId: string;             // source_dataset.id
  sourceRef?: string;           // record reference, e.g. metric_observation id or assumption code
  periodStart?: string;         // ISO date
  periodEnd?: string;
  asOf?: string;                // date the value was observed / published
  sampleSize?: number;
  /** Declares what the number already includes, to catch double counting (e.g. 'visibility'). */
  alreadyAdjustedFor?: string[];
}

export interface InputTrace {
  code: string;
  label: string;
  unit: string;
  status: ModelInput["status"];
  sourceId: string;
  sourceRef?: string;
  values: Record<Scenario, number>;
  periodStart?: string;
  periodEnd?: string;
  asOf?: string;
  sampleSize?: number;
}

export interface Estimate {
  metric: string;               // metric_definition.code
  metricVersion: number;
  unit: string;
  status: ValueStatus;          // 'internally_modeled' for our models, 'unavailable' when inputs are missing
  values: Record<Scenario, number> | null;
  formula: string;
  inputs: InputTrace[];
  warnings: string[];
  unavailableReason?: string;
  /** Scenario values are bounds from input ranges, NOT a statistical confidence interval. */
  scenarioNote: string;
}

export const SCENARIO_NOTE =
  "Low/base/high combine the low, base and high values of every uncertain input. They show sensitivity to assumptions; they are not a statistical confidence interval and are not audited or accredited.";

export function scenarioValue(input: ModelInput, s: Scenario): number {
  return typeof input.value === "number" ? input.value : input.value[s];
}

export function trace(input: ModelInput): InputTrace {
  return {
    code: input.code,
    label: input.label,
    unit: input.unit,
    status: input.status,
    sourceId: input.sourceId,
    sourceRef: input.sourceRef,
    values: { low: scenarioValue(input, "low"), base: scenarioValue(input, "base"), high: scenarioValue(input, "high") },
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    asOf: input.asOf,
    sampleSize: input.sampleSize,
  };
}

export function unavailable(metric: string, metricVersion: number, unit: string, formula: string, reason: string, inputs: ModelInput[] = []): Estimate {
  return {
    metric,
    metricVersion,
    unit,
    status: "unavailable",
    values: null,
    formula,
    inputs: inputs.map(trace),
    warnings: [],
    unavailableReason: reason,
    scenarioNote: SCENARIO_NOTE,
  };
}
