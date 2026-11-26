/**
 * Venue audience profile: context indicators (public data) + per-asset exposure estimates
 * (lib/measurement) with full provenance, honoring license restrictions for client output.
 */
import { demoFilter, q } from "./db";
import { allowedUses, attributions, SourceLicense, Use } from "./licensing";
import { checkoutContacts, hotelLobbyVisits, opportunityToSee, pumpTopContacts, screenAdContacts, staticFaceContacts } from "./measurement/models";
import { Estimate, ModelInput, unavailable } from "./measurement/types";

export const PERIOD_DAYS = 28; // JPG standard 4-week cycle

export interface Observation {
  id: string; subject_id: string; metric_code: string; value: string | null; unit: string; period_start: string | null; period_end: string | null;
  geo_scope: string | null; value_status: string; source_id: string; source_record_ref: string | null; formula: string | null;
  inputs: Record<string, unknown>; sample_size: string | null; quality_flags: string[]; imported_at: string; is_demo: boolean;
}
export interface AssetRow {
  id: string; asset_key: string; name: string; format_code: string; format_name: string; placement: string | null; is_digital: boolean;
  spot_length_s: string | null; loop_length_s: string | null; slots_per_loop: number | null; faces: number; status: string;
  rate_text: string | null; rate_4wk_usd: string | null; attributes: Record<string, unknown>; source_id: string; source_record_ref: string | null; is_demo: boolean;
  width_in: string | null; height_in: string | null; operator_frame_id: string | null;
}
export interface VenueRow {
  id: string; name: string; venue_type: string; operator_name: string | null; address: string | null; city: string | null; zip: string | null;
  island: string | null; lat: number | null; lon: number | null; location_quality: string; status: string; source_id: string; is_demo: boolean; updated_at: string;
}
export interface Assumption { code: string; applies_to: string; description: string; unit: string; low_value: string; base_value: string; high_value: string; rationale: string; source_id: string; status: string }

export interface AssetEstimate { asset: AssetRow; estimate: Estimate; needed: string[]; sourceIds: string[]; allowedUses: Use[] }

export interface VenueProfile {
  venue: VenueRow;
  assets: AssetRow[];
  context: Observation[];             // public-data context indicators
  venueCounts: Observation[];         // venue-provided / vendor counts used as model inputs
  estimates: AssetEstimate[];
  registry: Map<string, SourceLicense & { name: string; documentation_url: string | null; license_name: string | null; connection_status: string; category: string }>;
  usedSourceIds: string[];
  attributions: string[];
  period: { start: string; end: string; days: number };
}

const num = (s: string | number | null | undefined) => (s == null ? null : Number(s));

export async function loadRegistry() {
  const rows = await q<SourceLicense & { name: string; documentation_url: string | null; license_name: string | null; connection_status: string; category: string }>(
    `SELECT id, name, provider, category, documentation_url, license_name, attribution_text, connection_status,
            permits_internal_analysis, permits_client_reports, permits_audience_activation, permits_redistribution FROM source_dataset`);
  return new Map(rows.map((r) => [r.id, r]));
}

export async function loadAssumptions(): Promise<Assumption[]> {
  return q<Assumption>("SELECT * FROM model_assumption ORDER BY applies_to, code");
}

function assumption(all: Assumption[], code: string, fmt: string): ModelInput | null {
  const a = all.find((x) => x.code === code && x.applies_to === fmt) ?? all.find((x) => x.code === code && x.applies_to === "*");
  if (!a || a.base_value == null) return null;
  return {
    code, label: a.description, unit: a.unit, status: "assumed", sourceId: a.source_id ?? "jpg_assumptions", sourceRef: `model_assumption:${a.code}/${a.applies_to}`,
    value: { low: Number(a.low_value), base: Number(a.base_value), high: Number(a.high_value) },
  };
}

function obsInput(o: Observation | undefined, code: string, label: string, scale = 1): ModelInput | null {
  if (!o || o.value == null) return null;
  return {
    code, label, unit: o.unit, status: o.value_status === "unavailable" ? "observed" : (o.value_status as ModelInput["status"]),
    value: Number(o.value) * scale, sourceId: o.source_id, sourceRef: `metric_observation:${o.id}`, periodStart: o.period_start ?? undefined,
    periodEnd: o.period_end ?? undefined, asOf: o.period_end ?? undefined, sampleSize: num(o.sample_size) ?? undefined,
  };
}

const fixed = (code: string, label: string, value: number, unit: string, sourceId: string, sourceRef: string): ModelInput =>
  ({ code, label, unit, status: "observed", value, sourceId, sourceRef });

/** Scales a count observed over N days to the standard period (pro-rata; flagged in label). */
function perPeriod(o: Observation | undefined, code: string, label: string): ModelInput | null {
  if (!o?.period_start || !o.period_end || o.value == null) return obsInput(o, code, label);
  const days = (Date.parse(o.period_end) - Date.parse(o.period_start)) / 86_400_000 + 1;
  const scale = PERIOD_DAYS / days;
  return obsInput(o, code, scale === 1 ? label : `${label} (scaled from ${days} days to ${PERIOD_DAYS})`, scale);
}

export async function venueProfile(venueId: string, asOfDate: string): Promise<VenueProfile | null> {
  const [venue] = await q<VenueRow>(
    `SELECT id::text, name, venue_type, operator_name, address, city, zip, island, ST_Y(location::geometry) lat, ST_X(location::geometry) lon,
            location_quality, status, source_id, is_demo, updated_at FROM venue v WHERE id = $1 AND ${demoFilter("v")}`, [venueId]);
  if (!venue) return null;
  const assets = await q<AssetRow>(
    `SELECT a.id::text, asset_key, a.name, format_code, f.name format_name, placement, a.is_digital, spot_length_s, loop_length_s, slots_per_loop, faces,
            a.status, rate_text, rate_4wk_usd, attributes, a.source_id, source_record_ref, a.is_demo, width_in, height_in, operator_frame_id
     FROM asset a JOIN media_format f ON f.code = a.format_code WHERE venue_id = $1 AND ${demoFilter("a")} ORDER BY format_code, a.name`, [venueId]);
  const obs = await q<Observation>(
    `SELECT id::text, subject_id, metric_code, value, unit, period_start::text, period_end::text, geo_scope, value_status, source_id, source_record_ref,
            formula, inputs, sample_size, quality_flags, imported_at, is_demo
     FROM metric_observation m WHERE ((subject_type='venue' AND subject_id=$1) OR (subject_type='asset' AND subject_id = ANY($2)))
       AND ${demoFilter("m")} ORDER BY metric_code, period_end DESC NULLS LAST`, [venueId, assets.map((a) => a.id)]);
  const registry = await loadRegistry();
  const assumptions = await loadAssumptions();
  // Published hotel occupancy for the venue's DBEDT region (Waikiki or island), most recent month.
  const region = /waik[iī]k[iī]/i.test(`${venue.name} ${venue.address ?? ""}`) ? "Waikiki"
    : ({ Oahu: "Oahu", Maui: "Maui County", Molokai: "Maui County", Lanai: "Maui County", "Hawaii Island": "Hawaii Island", Kauai: "Kauai" } as Record<string, string>)[venue.island ?? ""];
  const regionOcc = venue.venue_type === "hotel" && region
    ? (await q<Observation>(`SELECT id::text, subject_id, metric_code, value, unit, period_start::text, period_end::text, geo_scope, value_status, source_id, source_record_ref,
          formula, inputs, sample_size, quality_flags, imported_at, is_demo FROM metric_observation m
          WHERE subject_type='geo_area' AND subject_id=$1 AND metric_code='hotel_occupancy_rate' AND ${demoFilter("m")} ORDER BY period_end DESC LIMIT 1`, [`dbedt_region:${region}`]))[0]
    : undefined;

  const latest = (code: string, assetId?: string) =>
    obs.find((o) => o.metric_code === code && (assetId ? o.subject_id === assetId : true));
  const contextCodes = new Set(["workers_within_400m", "workers_within_800m", "workers_within_1600m", "aadt_nearest_road", "acs_population_tract", "acs_median_hh_income_tract", "poi_count_400m"]);
  const ORDER = ["workers_within_400m", "workers_within_800m", "workers_within_1600m", "aadt_nearest_road"];
  const rank = (c: string) => (ORDER.indexOf(c) === -1 ? 99 : ORDER.indexOf(c));
  const context = obs.filter((o) => contextCodes.has(o.metric_code) || o.metric_code.startsWith("acs_")).sort((a, b) => rank(a.metric_code) - rank(b.metric_code));
  const venueCounts = obs.filter((o) => !contextCodes.has(o.metric_code) && !o.metric_code.startsWith("acs_"));

  const end = asOfDate;
  const start = new Date(Date.parse(asOfDate) - (PERIOD_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const ctx = { asOfDate };
  const estimates: AssetEstimate[] = [];

  for (const a of assets) {
    const fmt = a.format_code;
    const A = (code: string) => assumption(assumptions, code, fmt);
    let est: Estimate;
    const needed: string[] = [];
    const derivedFrom: Estimate["inputs"] = [];
    if (fmt === "cstore_screen" || fmt === "hotel_screen" || fmt === "mall_screen") {
      let visits: ModelInput | null = perPeriod(latest("venue_visits"), "venue_visits", "Venue visits in operating hours");
      if (!visits && fmt === "hotel_screen") {
        const rooms = a.attributes?.kit_rooms as number | undefined;
        const occ = latest("hotel_occupancy_rate") ?? regionOcc;
        if (rooms && occ) {
          const hv = hotelLobbyVisits({
            rooms: fixed("rooms", "Rooms (venue-published, JPG media kit)", rooms, "rooms", a.source_id, a.source_record_ref ?? `asset:${a.id}`),
            occupancy_rate: obsInput(occ, "occupancy_rate", occ === regionOcc ? `Hotel occupancy, ${occ.geo_scope} (${occ.period_start?.slice(0, 7)})` : "Hotel occupancy rate (venue-provided)")!,
            guests_per_occupied_room: A("guests_per_occupied_room")!,
            lobby_passes_per_guest_day: A("lobby_passes_per_guest_day")!,
            days: fixed("days", "Days in period", PERIOD_DAYS, "days", "jpg_model", "PERIOD_DAYS"),
          }, ctx);
          if (hv.values) {
            visits = { code: "venue_visits", label: "Lobby visits (derived: rooms x occupancy x assumptions)", unit: "visits", status: "assumed", value: hv.values, sourceId: "jpg_model", sourceRef: hv.formula };
            derivedFrom.push(...hv.inputs);
          }
        } else if (rooms && !occ) needed.push("Hotel occupancy rate for the island/period (DBEDT monthly hotel performance)");
      }
      if (!visits) needed.push("Venue visits (door counts or register transactions) for a recent period");
      const opHours = latest("operating_hours_per_day");
      if (!opHours) needed.push("Screen operating hours per day");
      const loop = num(a.loop_length_s);
      if (!loop) needed.push("Loop length (seconds) from CMS schedule");
      const plays = latest("verified_plays", a.id);
      if (visits && (!opHours || !loop)) {
        // Visits known but loop spec / hours missing: report opportunity-to-see visits, not ad contacts.
        est = opportunityToSee(visits, A("p_in_view_zone")!, ctx);
        if (derivedFrom.length) est = { ...est, inputs: [...derivedFrom, ...est.inputs] };
        est.warnings.unshift("Opportunity-to-see VISITS only. Ad contacts need loop length and operating hours (see list below).");
        needed.splice(0, needed.length, ...needed.filter((n) => !n.startsWith("Venue visits")));
        const sourceIds = [...new Set([a.source_id, ...est.inputs.map((i) => i.sourceId)])];
        estimates.push({ asset: a, estimate: est, needed, sourceIds, allowedUses: allowedUses(sourceIds, registry) });
        continue;
      }
      est = screenAdContacts({
        venue_visits: visits!,
        operating_seconds: opHours ? fixed("operating_seconds", "Operating seconds in period", Number(opHours.value) * 3600 * PERIOD_DAYS, "seconds", opHours.source_id, `metric_observation:${opHours.id}`) : (null as never),
        dwell_seconds: A("dwell_seconds")!,
        p_in_view_zone: A("p_in_view_zone")!,
        loop_length_seconds: loop ? fixed("loop_length_seconds", "Loop length", loop, "seconds", a.source_id, `asset:${a.id}`) : (null as never),
        spot_length_seconds: fixed("spot_length_seconds", "Spot length", num(a.spot_length_s) ?? 15, "seconds", a.source_id, `asset:${a.id}`),
        ad_spots_per_loop: fixed("ad_spots_per_loop", "Ad spots per loop (standard buy = 1)", 1, "spots", "jpg_model", "standard package"),
        verified_plays: plays ? obsInput(plays, "verified_plays", "Verified plays (proof-of-play)") : null,
        uptime_share: plays ? null : A("uptime_share"),
      }, ctx);
    } else if (fmt === "pump_top") {
      const tx = perPeriod(latest("fueling_transactions"), "fueling_transactions", "Fueling transactions");
      const pos = latest("fueling_positions");
      if (!tx) needed.push("Fueling transactions for a recent period (station POS report)");
      if (!pos) needed.push("Number of fueling positions at the station");
      est = pumpTopContacts({
        fueling_transactions: tx!, fueling_positions: obsInput(pos, "fueling_positions", "Fueling positions")!,
        positions_covered: A("positions_covered")!, viewers_per_transaction: A("viewers_per_transaction")!,
      }, ctx);
    } else if (fmt === "checkout") {
      const tx = perPeriod(latest("register_transactions"), "transactions", "Register transactions");
      const lane = latest("lane_share", a.id) ?? latest("lane_share");
      if (!tx) needed.push("Register transactions for a recent period (store-provided)");
      if (!lane) needed.push("Share of transactions through lanes carrying this media");
      est = checkoutContacts({ transactions: tx!, lane_share: obsInput(lane, "lane_share", "Lane share")!, shoppers_per_transaction: A("shoppers_per_transaction")! }, ctx);
    } else if (fmt === "mall_static") {
      const ped = perPeriod(latest("pedestrians_passing", a.id), "pedestrians_passing", "Pedestrians passing face");
      const facesRoad = a.attributes?.faces_road === true;
      const aadt = latest("aadt_nearest_road");
      const veh = facesRoad && aadt ? obsInput(aadt, "vehicles_passing", `Vehicles passing (AADT x ${PERIOD_DAYS} days)`, PERIOD_DAYS) : null;
      if (!ped) needed.push("Pedestrian count past this face (center traffic counter or manual count)");
      if (!facesRoad) needed.push("Site survey confirming the face is visible from the adjacent road (required before using road AADT)");
      est = staticFaceContacts({
        pedestrians_passing: ped, p_visible_pedestrian: A("p_visible_pedestrian"),
        vehicles_passing: veh, vehicle_occupancy: A("vehicle_occupancy"), p_visible_vehicle: A("p_visible_vehicle"),
      }, ctx);
    } else {
      needed.push("GPS route log with timestamps for the vehicle, plus traffic volumes for driven segments");
      est = unavailable("ad_contacts_ots", 1, "contacts", "see vehicleContacts()", "No GPS route data imported for this vehicle.");
    }
    if (derivedFrom.length) est = { ...est, inputs: [...derivedFrom, ...est.inputs] };
    const sourceIds = [...new Set([a.source_id, ...est.inputs.map((i) => i.sourceId)])];
    estimates.push({ asset: a, estimate: est, needed: est.status === "unavailable" ? needed : [], sourceIds, allowedUses: allowedUses(sourceIds, registry) });
  }

  const usedSourceIds = [...new Set([venue.source_id, ...assets.map((a) => a.source_id), ...context.map((c) => c.source_id), ...estimates.flatMap((e) => e.sourceIds)])];
  return { venue, assets, context, venueCounts, estimates, registry, usedSourceIds, attributions: attributions(usedSourceIds, registry), period: { start, end, days: PERIOD_DAYS } };
}

/** Removes everything a client may not see. Returns the excluded items so the report can say so. */
export function restrictForClient(p: VenueProfile) {
  const ok = (ids: string[]) => allowedUses(ids, p.registry).includes("client_report");
  const context = p.context.filter((o) => ok([o.source_id]));
  const blocked = (e: AssetEstimate) => e.estimate.status !== "unavailable" && !e.allowedUses.includes("client_report");
  const estimates: AssetEstimate[] = p.estimates.map((e) => blocked(e)
    ? { ...e, needed: [], sourceIds: [e.asset.source_id], estimate: unavailable(e.estimate.metric, e.estimate.metricVersion, e.estimate.unit, e.estimate.formula, "Withheld from client reports under data-license terms.") }
    : e);
  const excluded = [
    ...p.context.filter((o) => !ok([o.source_id])).map((o) => `${o.metric_code} (source: ${o.source_id})`),
    ...[...new Set(p.estimates.filter(blocked).map((e) => `${e.asset.format_name} estimate (blocked by: ${e.sourceIds.filter((s) => !ok([s])).join(", ")})`))],
  ];
  return { ...p, context, estimates, excluded };
}
