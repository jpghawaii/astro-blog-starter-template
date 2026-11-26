/**
 * License-aware use control. A derived number inherits the MOST restrictive permission of
 * every source that fed it. Unknown permission (null) is treated as NOT permitted.
 */

export type Use = "internal" | "client_report" | "activation" | "redistribution";

export interface SourceLicense {
  id: string;
  name: string;
  permits_internal_analysis: boolean | null;
  permits_client_reports: boolean | null;
  permits_audience_activation: boolean | null;
  permits_redistribution: boolean | null;
  attribution_text?: string | null;
}

const field: Record<Use, keyof SourceLicense> = {
  internal: "permits_internal_analysis",
  client_report: "permits_client_reports",
  activation: "permits_audience_activation",
  redistribution: "permits_redistribution",
};

export function permits(src: SourceLicense | undefined, use: Use): boolean {
  if (!src) return false;
  return src[field[use]] === true;
}

/** Uses allowed for a value derived from all the given sources. */
export function allowedUses(sourceIds: string[], registry: Map<string, SourceLicense>): Use[] {
  const uses: Use[] = ["internal", "client_report", "activation", "redistribution"];
  const ids = [...new Set(sourceIds)];
  return uses.filter((u) => ids.every((id) => permits(registry.get(id), u)));
}

export interface Restrictable { sourceIds: string[] }

export interface ExportDecision<T> { included: T[]; excluded: { item: T; blockingSources: string[] }[] }

/** Splits items into those exportable for `use` and those blocked, naming the blocking sources. */
export function filterForUse<T extends Restrictable>(items: T[], use: Use, registry: Map<string, SourceLicense>): ExportDecision<T> {
  const out: ExportDecision<T> = { included: [], excluded: [] };
  for (const item of items) {
    const blocking = [...new Set(item.sourceIds)].filter((id) => !permits(registry.get(id), use));
    if (blocking.length) out.excluded.push({ item, blockingSources: blocking });
    else out.included.push(item);
  }
  return out;
}

export function attributions(sourceIds: string[], registry: Map<string, SourceLicense>): string[] {
  return [...new Set(sourceIds)].map((id) => registry.get(id)?.attribution_text).filter((x): x is string => !!x);
}
