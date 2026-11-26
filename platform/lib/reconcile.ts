/**
 * Name/identifier reconciliation and revenue reconciliation.
 * Matches above AUTO_MATCH are applied automatically; between REVIEW and AUTO_MATCH they go to
 * the exceptions queue; below REVIEW they are reported as unmatched.
 */

export const AUTO_MATCH = 0.92;
export const REVIEW = 0.6;

const STOP = new Set(["the", "inc", "llc", "ltd", "co", "corp", "dba", "hawaii", "hi", "store", "center", "centre"]);
const ABBR: Record<string, string> = { aim: "aloha island mart", ave: "avenue", st: "street", hwy: "highway", blvd: "boulevard", rd: "road", ctr: "center", mkt: "market" };

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯʻ‘’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBR[t] ?? t)
    .join(" ")
    .split(" ")
    .filter((t) => !STOP.has(t))
    .join(" ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient on character bigrams of normalized names, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na), B = bigrams(nb);
  let inter = 0, total = 0;
  for (const [g, c] of A) { inter += Math.min(c, B.get(g) ?? 0); total += c; }
  for (const c of B.values()) total += c;
  return (2 * inter) / total;
}

export interface Candidate { id: string; name: string; lat?: number | null; lon?: number | null }
export interface MatchDecision { decision: "auto" | "review" | "unmatched"; best?: Candidate; score: number; candidates: { c: Candidate; score: number }[] }

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_008.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Combines name similarity with a distance bonus/penalty when both sides have coordinates. */
export function matchRecord(name: string, lat: number | null | undefined, lon: number | null | undefined, candidates: Candidate[]): MatchDecision {
  const scored = candidates.map((c) => {
    let s = nameSimilarity(name, c.name);
    if (lat != null && lon != null && c.lat != null && c.lon != null) {
      const d = haversineM(lat, lon, c.lat, c.lon);
      if (d < 75) s = Math.min(1, s + 0.1);
      else if (d > 2000) s = s * 0.6; // same name far away (chain stores) is not the same venue
    }
    return { c, score: Math.round(s * 1000) / 1000 };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return { decision: "unmatched", score: 0, candidates: [] };
  const second = scored[1];
  // Ambiguous when two candidates are near-equal, even with a high top score.
  const ambiguous = second && top.score - second.score < 0.05;
  const decision = top.score >= AUTO_MATCH && !ambiguous ? "auto" : top.score >= REVIEW ? "review" : "unmatched";
  return { decision, best: top.c, score: top.score, candidates: scored.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Revenue reconciliation: invoice lines vs booked value per campaign.
// ---------------------------------------------------------------------------
export interface InvoiceLineLite { id: string; campaignId: string | null; customer: string; amount: number; date: string }
export interface CampaignBookedValue { campaignId: string; advertiser: string; bookedValue: number | null; flightStart: string; flightEnd: string }

export interface RevenueRecon {
  campaignId: string;
  advertiser: string;
  bookedValue: number | null;
  invoiced: number;
  difference: number | null;
  flag: "ok" | "under_invoiced" | "over_invoiced" | "no_booking_value" | "not_invoiced";
}

export interface RevenueReconReport { rows: RevenueRecon[]; unlinkedInvoiceLines: InvoiceLineLite[]; unlinkedTotal: number; tolerance: number; note: string }

export function reconcileRevenue(campaigns: CampaignBookedValue[], lines: InvoiceLineLite[], tolerance = 1): RevenueReconReport {
  const byCampaign = new Map<string, number>();
  const unlinked: InvoiceLineLite[] = [];
  for (const l of lines) {
    if (!l.campaignId) { unlinked.push(l); continue; }
    byCampaign.set(l.campaignId, (byCampaign.get(l.campaignId) ?? 0) + l.amount);
  }
  const rows: RevenueRecon[] = campaigns.map((c) => {
    const inv = Math.round((byCampaign.get(c.campaignId) ?? 0) * 100) / 100;
    if (c.bookedValue == null) return { campaignId: c.campaignId, advertiser: c.advertiser, bookedValue: null, invoiced: inv, difference: null, flag: "no_booking_value" };
    const diff = Math.round((inv - c.bookedValue) * 100) / 100;
    const flag = inv === 0 ? "not_invoiced" : Math.abs(diff) <= tolerance ? "ok" : diff < 0 ? "under_invoiced" : "over_invoiced";
    return { campaignId: c.campaignId, advertiser: c.advertiser, bookedValue: c.bookedValue, invoiced: inv, difference: diff, flag };
  });
  return {
    rows,
    unlinkedInvoiceLines: unlinked,
    unlinkedTotal: Math.round(unlinked.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    tolerance,
    note: "Invoiced revenue is an accounting fact. It is not evidence that ads were delivered or that inventory was occupied.",
  };
}
