import { NextResponse } from "next/server";
import { audit, currentUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: Record<string, unknown>[]) => rows.length ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map(esc).join(","))].join("\n") : "";

/** CSV exports contain only columns whose sources permit the export; the source/license is included per column group. */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });
  const { kind } = await params;
  const u = new URL(req.url);
  let rows: Record<string, unknown>[];
  if (kind === "venues") {
    rows = await q(
      `SELECT v.id venue_id, v.name, v.venue_type, v.address, v.city, v.island, ST_Y(v.location::geometry) lat, ST_X(v.location::geometry) lon, v.location_quality, v.status record_status,
              (SELECT count(*) FROM asset a WHERE a.venue_id=v.id) assets,
              w.value jobs_within_800m, w.period_start::text jobs_vintage, 'census_lodes8' jobs_source,
              t.value aadt_nearest_road, t.geo_scope aadt_scope, 'hdot_hpms_2024' aadt_source, v.is_demo
       FROM venue v
       LEFT JOIN metric_observation w ON w.subject_type='venue' AND w.subject_id=v.id::text AND w.metric_code='workers_within_800m'
       LEFT JOIN metric_observation t ON t.subject_type='venue' AND t.subject_id=v.id::text AND t.metric_code='aadt_nearest_road'
       WHERE ${demoFilter("v")} AND ($1::text IS NULL OR v.island=$1) AND ($2::text IS NULL OR v.venue_type=$2) ORDER BY v.island, v.name`,
      [u.searchParams.get("island"), u.searchParams.get("type")]);
  } else if (kind === "assets") {
    rows = await q(
      `SELECT a.id asset_id, a.asset_key, v.name venue, v.island, f.name format, a.placement, a.is_digital, a.status, a.rate_4wk_usd, a.rate_text, a.source_id, a.source_record_ref, a.is_demo
       FROM asset a JOIN venue v ON v.id=a.venue_id JOIN media_format f ON f.code=a.format_code WHERE ${demoFilter("a")} ORDER BY v.island, v.name`);
  } else {
    return new NextResponse("unknown export", { status: 404 });
  }
  await audit(user.id, "export_csv", kind, { rows: rows.length });
  return new NextResponse(csv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="jpg-${kind}-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
