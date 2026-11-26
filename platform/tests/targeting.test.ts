import { describe, expect, it } from "vitest";
import { recommend, AdvertiserSignals, FormatSupply } from "../lib/targeting";

const supply: FormatSupply[] = [
  { format: "cstore_screen", formatName: "C-store screen", units: 160, venuesWithContext: 90, medianJobs800: 4000, typical4wkPrice: 500 },
  { format: "hotel_screen", formatName: "Hotel screen", units: 25, venuesWithContext: 0, medianJobs800: null, typical4wkPrice: 500 },
  { format: "checkout", formatName: "Checkout", units: 0, venuesWithContext: 0, medianJobs800: null, typical4wkPrice: null },
];
const base: AdvertiserSignals = { id: "1", name: "X", industry: "Food & Drink", inventoryInterest: ["Digital"], crmStage: "Prospect", crmPriority: "A",
  estDealValue: null, mediaRevenue12m: null, lastInvoiceDate: null, hasAuthorizedContact: false, sources: ["monday_sales"] };

describe("advertiser recommendations", () => {
  it("excludes unavailable components from the score instead of scoring them zero", () => {
    const r = recommend(base, supply, new Date("2026-11-26"));
    const budget = r.components.find((c) => c.name === "Budget fit")!;
    expect(budget.score).toBeNull();
    // available: category 1 (0.35), interest 1 (0.15), context 0.8 (0.15), relationship 0.4 (0.2)
    expect(r.score).toBe(Math.round(100 * (0.35 * 1 + 0.15 * 1 + 0.15 * 0.8 + 0.2 * 0.4) / 0.85));
  });
  it("never recommends formats with no available units", () => {
    const r = recommend({ ...base, industry: "Food & Drink" }, supply);
    expect(r.bestFormats.map((b) => b.format)).not.toContain("checkout");
  });
  it("withholds a score when most inputs are missing and explains why", () => {
    const r = recommend({ ...base, industry: null, inventoryInterest: [], crmStage: null }, supply);
    expect(r.score).toBeNull();
    expect(r.cautions.join(" ")).toMatch(/Less than half/);
  });
  it("ranks an existing customer's relationship highest", () => {
    const r = recommend({ ...base, mediaRevenue12m: 12000, lastInvoiceDate: "2026-10-01" }, supply);
    expect(r.components.find((c) => c.name === "Relationship")!.score).toBe(1);
  });
});
