/**
 * Occupancy = booked capacity-unit-days / available capacity-unit-days over a date range.
 *
 * Units are explicit and never mixed:
 *   spot_slot   - digital: number of sellable advertiser slots in the loop (e.g. 6 of 15s in a 90s loop)
 *   face_period - static: one physical face sellable to one advertiser at a time
 * Invoices are NOT used here: invoice revenue is not proof of booking, delivery, or occupancy.
 */

export type CapacityUnit = "spot_slot" | "face_period";

export interface DateRange { start: string; end: string } // inclusive ISO dates

export interface CapacityRow { assetId: string; start: string; end: string; unit: CapacityUnit; capacity: number }
export interface BookingRow { assetId: string; start: string; end: string; unit: CapacityUnit; units: number; status: "hold" | "confirmed" | "cancelled" }

export interface OccupancyResult {
  unit: CapacityUnit;
  range: DateRange;
  capacityUnitDays: number | null;     // null = no capacity defined -> occupancy unavailable
  bookedUnitDays: number;
  holdUnitDays: number;
  occupancy: number | null;            // confirmed only
  occupancyInclHolds: number | null;
  overbookedDays: { assetId: string; date: string; booked: number; capacity: number }[];
  assetsWithoutCapacity: string[];
  warnings: string[];
}

const DAY = 86_400_000;
const toDay = (iso: string) => Math.floor(Date.parse(iso + "T00:00:00Z") / DAY);
const fromDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);

export function occupancy(assetIds: string[], capacity: CapacityRow[], bookings: BookingRow[], range: DateRange, unit: CapacityUnit): OccupancyResult {
  const r0 = toDay(range.start);
  const r1 = toDay(range.end);
  if (r1 < r0) throw new Error("range end before start");
  const warnings: string[] = [];
  const assets = new Set(assetIds);

  const mixed = [...capacity, ...bookings].filter((x) => assets.has(x.assetId) && x.unit !== unit);
  if (mixed.length) warnings.push(`${mixed.length} capacity/booking rows use a different unit and were excluded (units are never mixed).`);

  // per asset per day capacity
  const capByAssetDay = new Map<string, number>();
  for (const c of capacity) {
    if (!assets.has(c.assetId) || c.unit !== unit) continue;
    const a = Math.max(r0, toDay(c.start));
    const b = Math.min(r1, toDay(c.end));
    for (let d = a; d <= b; d++) {
      const k = `${c.assetId}|${d}`;
      if (capByAssetDay.has(k)) warnings.push(`Overlapping capacity periods for asset ${c.assetId} on ${fromDay(d)}; latest row used.`);
      capByAssetDay.set(k, c.capacity);
    }
  }
  const assetsWithoutCapacity = assetIds.filter((id) => ![...capByAssetDay.keys()].some((k) => k.startsWith(id + "|")));

  const booked = new Map<string, number>();
  const held = new Map<string, number>();
  for (const b of bookings) {
    if (!assets.has(b.assetId) || b.unit !== unit || b.status === "cancelled") continue;
    const a = Math.max(r0, toDay(b.start));
    const e = Math.min(r1, toDay(b.end));
    for (let d = a; d <= e; d++) {
      const k = `${b.assetId}|${d}`;
      const m = b.status === "confirmed" ? booked : held;
      m.set(k, (m.get(k) ?? 0) + b.units);
    }
  }

  let capDays = 0, bookedDays = 0, holdDays = 0;
  const overbookedDays: OccupancyResult["overbookedDays"] = [];
  for (const [k, cap] of capByAssetDay) {
    capDays += cap;
    const bk = booked.get(k) ?? 0;
    const hd = held.get(k) ?? 0;
    // Count booked days only where capacity exists; bookings on undefined capacity are flagged.
    bookedDays += Math.min(bk, cap);
    holdDays += Math.min(hd, Math.max(0, cap - bk));
    if (bk > cap) {
      const [assetId, d] = k.split("|");
      overbookedDays.push({ assetId, date: fromDay(Number(d)), booked: bk, capacity: cap });
    }
  }
  for (const k of booked.keys()) {
    if (!capByAssetDay.has(k)) {
      warnings.push(`Booking on asset ${k.split("|")[0]} has no capacity defined for some days; those days are excluded.`);
      break;
    }
  }
  if (overbookedDays.length) warnings.push(`${overbookedDays.length} asset-days are overbooked (booked > capacity); occupancy capped at 100% for those days.`);
  if (assetsWithoutCapacity.length) warnings.push(`${assetsWithoutCapacity.length} asset(s) have no capacity defined in range and are excluded from the denominator.`);

  return {
    unit,
    range,
    capacityUnitDays: capDays > 0 ? capDays : null,
    bookedUnitDays: bookedDays,
    holdUnitDays: holdDays,
    occupancy: capDays > 0 ? bookedDays / capDays : null,
    occupancyInclHolds: capDays > 0 ? (bookedDays + holdDays) / capDays : null,
    overbookedDays,
    assetsWithoutCapacity,
    warnings,
  };
}
