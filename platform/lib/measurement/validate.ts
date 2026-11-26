import { ModelInput, SCENARIOS, scenarioValue } from "./types";

export interface Requirement {
  code: string;
  kind: "count" | "seconds" | "probability" | "ratio" | "positive";
  optional?: boolean;
}

/** Returns a reason string if any required input is missing or invalid, else null. */
export function checkInputs(inputs: Record<string, ModelInput | null | undefined>, reqs: Requirement[]): string | null {
  const missing: string[] = [];
  for (const r of reqs) {
    const inp = inputs[r.code];
    if (!inp) {
      if (!r.optional) missing.push(r.code);
      continue;
    }
    if (typeof inp.value !== "number") {
      const { low, base, high } = inp.value;
      if (!(low <= base && base <= high)) return `${r.code}: scenario values must satisfy low <= base <= high`;
    }
    for (const s of SCENARIOS) {
      const v = scenarioValue(inp, s);
      if (!Number.isFinite(v)) return `${r.code}: value is not a finite number`;
      if (v < 0) return `${r.code}: negative value`;
      if (r.kind === "probability" && v > 1) return `${r.code}: probability above 1`;
      if ((r.kind === "seconds" || r.kind === "positive") && v === 0) return `${r.code}: must be greater than zero`;
    }
  }
  return missing.length ? `Missing required input(s): ${missing.join(", ")}` : null;
}

/**
 * Double-counting guard: a factor must not be applied to an input that already includes it
 * (e.g. applying a visibility share to a vendor "exposed audience" figure).
 */
export function doubleCountViolations(inputs: ModelInput[], appliedFactors: string[]): string[] {
  const out: string[] = [];
  for (const inp of inputs) {
    for (const f of inp.alreadyAdjustedFor ?? []) {
      if (appliedFactors.includes(f)) out.push(`${inp.code} already includes '${f}', so the ${f} factor would be double-counted`);
    }
  }
  return out;
}

/** Warns when an input is older than maxAgeDays relative to asOfDate. */
export function staleWarnings(inputs: ModelInput[], asOfDate: string, maxAgeDays: number): string[] {
  const ref = Date.parse(asOfDate);
  const out: string[] = [];
  for (const i of inputs) {
    const d = i.asOf ?? i.periodEnd;
    if (!d || i.status === "assumed") continue;
    const ageDays = (ref - Date.parse(d)) / 86_400_000;
    if (ageDays > maxAgeDays) out.push(`STALE: ${i.code} is dated ${d} (${Math.round(ageDays)} days old; threshold ${maxAgeDays})`);
  }
  return out;
}

export function smallSampleWarnings(inputs: ModelInput[], minSample = 30): string[] {
  return inputs
    .filter((i) => i.sampleSize !== undefined && i.sampleSize < minSample)
    .map((i) => `SMALL SAMPLE: ${i.code} is based on n=${i.sampleSize} (< ${minSample})`);
}
