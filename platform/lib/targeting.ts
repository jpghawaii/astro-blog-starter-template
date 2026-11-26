/**
 * Contextual advertiser recommendations. Business-level only: no individual targeting, no inference
 * of sensitive characteristics. Every score component is explained; components without data are
 * reported as unavailable and excluded from the weighted average (never scored as zero).
 */

export type Industry = "Food & Drink" | "Medical" | "Real Estate" | "Financial" | "Auto" | "Tourism" | "Retail" | "Telecom" | "Government" | "Military" | "Agency" | "Other";

/**
 * Category fit by media format (0-1). JPG Media sales heuristic, v1: a documented judgment, not a
 * measured response rate. Rationale strings appear in the recommendation explanation.
 */
export const CATEGORY_FIT: Record<string, Partial<Record<Industry, [number, string]>>> = {
  cstore_screen: {
    "Food & Drink": [1, "point-of-purchase screens where snacks/beverages are bought"],
    Auto: [0.8, "drivers at fuel stations"], Telecom: [0.6, "high-frequency everyday shoppers"], Financial: [0.5, "broad local reach"],
    Medical: [0.5, "broad local reach"], Tourism: [0.4, "some visitor traffic"], Retail: [0.6, "nearby retail occasions"], Government: [0.6, "public-service messaging to residents"],
  },
  pump_top: {
    Auto: [1, "message in front of the driver while fueling"], "Food & Drink": [0.8, "in-store purchase follows fueling"], Financial: [0.5, "captive dwell at pump"],
    Telecom: [0.5, "captive dwell at pump"], Medical: [0.4, "broad local reach"], Government: [0.6, "public-service messaging"], Retail: [0.5, "nearby retail occasions"],
  },
  checkout: {
    "Food & Drink": [1, "grocery shopping mission"], Medical: [0.7, "household health decision makers"], Financial: [0.7, "household financial decision makers"],
    Retail: [0.6, "shopping mindset"], Telecom: [0.5, "household services"], "Real Estate": [0.4, "local residents"], Government: [0.6, "residents"],
  },
  hotel_screen: {
    Tourism: [1, "visitors planning activities"], "Food & Drink": [0.8, "visitor dining decisions"], Retail: [0.8, "visitor shopping"],
    "Real Estate": [0.5, "affluent visitors / second-home buyers"], Auto: [0.4, "rental and visitor mobility"], Financial: [0.3, "limited local relevance"],
  },
  mall_static: {
    Retail: [1, "shopping center audience"], "Food & Drink": [0.9, "dining in center"], "Real Estate": [0.7, "residential neighborhood centers"],
    Medical: [0.7, "community health services"], Financial: [0.8, "community banking"], Auto: [0.6, "roadside frontage"], Telecom: [0.6, "retail occasions"],
  },
  mall_screen: {
    Retail: [1, "shopping center audience"], "Food & Drink": [1, "food court"], Medical: [0.6, "families"], Financial: [0.6, "community"], Tourism: [0.5, "some visitors"],
  },
  vehicle: {
    "Real Estate": [0.7, "neighborhood coverage"], Auto: [0.7, "on-road audience"], "Food & Drink": [0.6, "broad reach"], Tourism: [0.8, "airport/resort routes (shuttles)"],
    Government: [0.7, "public-service campaigns"],
  },
};

export interface AdvertiserSignals {
  id: string;
  name: string;
  industry: string | null;
  inventoryInterest: string[];          // CRM 'Inventory' dropdown: Digital, Grocery, Mall, Hotel, Outdoor, Mix
  crmStage: string | null;
  crmPriority: string | null;
  estDealValue: number | null;
  mediaRevenue12m: number | null;       // QuickBooks media-class revenue, last 12 months (null = not a customer / no access)
  lastInvoiceDate: string | null;
  hasAuthorizedContact: boolean;
  sources: string[];
}

export interface FormatSupply { format: string; formatName: string; units: number; venuesWithContext: number; medianJobs800: number | null; typical4wkPrice: number | null }

export interface Component { name: string; score: number | null; weight: number; reason: string }
export interface Recommendation {
  advertiser: AdvertiserSignals;
  score: number | null;                 // 0-100 over available components
  components: Component[];
  bestFormats: { format: string; formatName: string; fit: number; why: string; units: number }[];
  reasons: string[];
  cautions: string[];
}

const INTEREST_TO_FORMATS: Record<string, string[]> = {
  Digital: ["cstore_screen", "hotel_screen", "mall_screen"], Grocery: ["checkout"], Mall: ["mall_static", "mall_screen"], Hotel: ["hotel_screen"], Outdoor: ["vehicle", "pump_top"], Mix: [],
};
const STAGE_SCORE: Record<string, number> = { Prospect: 0.4, Contacted: 0.5, Replied: 0.7, Meeting: 0.8, Proposal: 0.9, Won: 1, Nurture: 0.3, Lost: 0.1 };

export function recommend(a: AdvertiserSignals, supply: FormatSupply[], today = new Date()): Recommendation {
  const ind = (a.industry ?? "Other") as Industry;
  const fits = supply.map((s) => {
    const f = CATEGORY_FIT[s.format]?.[ind];
    return { format: s.format, formatName: s.formatName, fit: f ? f[0] : 0, why: f ? f[1] : "no documented fit", units: s.units, supply: s };
  }).filter((f) => f.units > 0).sort((x, y) => y.fit - x.fit);
  const best = fits.filter((f) => f.fit >= 0.6).slice(0, 3);
  const components: Component[] = [];
  const cautions: string[] = [];

  // 1. Category fit (heuristic matrix)
  components.push({
    name: "Category fit", weight: 0.35,
    score: a.industry ? (best[0]?.fit ?? 0) : null,
    reason: a.industry ? (best.length ? `${ind}: ${best.map((b) => `${b.formatName} (${b.why})`).join("; ")}` : `${ind} has no strong documented fit with available formats`) : "industry unknown",
  });
  // 2. Stated inventory interest (CRM)
  const wanted = new Set(a.inventoryInterest.flatMap((i) => INTEREST_TO_FORMATS[i] ?? []));
  components.push({
    name: "Stated inventory interest", weight: 0.15,
    score: a.inventoryInterest.length ? (best.some((b) => wanted.has(b.format)) || a.inventoryInterest.includes("Mix") ? 1 : 0.3) : null,
    reason: a.inventoryInterest.length ? `CRM lists interest in ${a.inventoryInterest.join(", ")}` : "no stated interest in CRM",
  });
  // 3. Venue context (daytime workforce around venues of the best format) - area context, not audience
  const ctx = best[0]?.supply;
  components.push({
    name: "Venue context", weight: 0.15,
    score: ctx && ctx.medianJobs800 != null ? Math.min(1, ctx.medianJobs800 / 5000) : null,
    reason: ctx && ctx.medianJobs800 != null ? `${ctx.venuesWithContext} ${ctx.formatName} venues measured; median ${Math.round(ctx.medianJobs800).toLocaleString()} jobs within 800 m (LODES 2024)` : "no measured context for best format",
  });
  // 4. Budget fit
  const price = ctx?.typical4wkPrice ?? null;
  const bud = a.estDealValue;
  components.push({
    name: "Budget fit", weight: 0.15,
    score: bud != null && price != null ? Math.min(1, bud / (price * 3)) : null,
    reason: bud != null && price != null ? `CRM estimate $${bud.toLocaleString()} vs ~$${price.toLocaleString()} per unit per 4 weeks` : "deal value or price unavailable",
  });
  // 5. Relationship signals
  const months = a.lastInvoiceDate ? (today.getTime() - Date.parse(a.lastInvoiceDate)) / (30.4 * 86_400_000) : null;
  let rel: number | null = null;
  const relWhy: string[] = [];
  if (a.mediaRevenue12m != null && a.mediaRevenue12m > 0) { rel = 1; relWhy.push(`existing customer: $${Math.round(a.mediaRevenue12m).toLocaleString()} media revenue in last 12 months`); }
  else if (months != null) { rel = months < 24 ? 0.7 : 0.4; relWhy.push(`past customer, last invoice ${a.lastInvoiceDate}`); }
  if (a.crmStage) { rel = Math.max(rel ?? 0, STAGE_SCORE[a.crmStage] ?? 0.4); relWhy.push(`CRM stage ${a.crmStage}${a.crmPriority ? `, priority ${a.crmPriority}` : ""}`); }
  components.push({ name: "Relationship", weight: 0.2, score: rel, reason: relWhy.join("; ") || "no CRM or billing history" });

  const avail = components.filter((c) => c.score != null);
  const wsum = avail.reduce((s, c) => s + c.weight, 0);
  const score = wsum >= 0.5 ? Math.round((100 * avail.reduce((s, c) => s + c.weight * (c.score as number), 0)) / wsum) : null;
  if (wsum < 0.5) cautions.push("Less than half of the scoring inputs are available; no score shown.");
  if (!a.hasAuthorizedContact) cautions.push("No authorized contact on file (CRM or licensed export).");
  cautions.push("Contextual (venue/format) recommendation only; no individual-level targeting.");
  const reasons = components.filter((c) => c.score != null && c.score >= 0.6).map((c) => `${c.name}: ${c.reason}`);
  return { advertiser: a, score, components, bestFormats: best.map(({ supply: _s, ...b }) => b), reasons, cautions };
}
