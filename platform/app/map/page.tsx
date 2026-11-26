import { requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";
import MapClient from "@/components/MapClient";
import type { MapVenue } from "@/components/VenueMap";
import { FORMAT_COLORS } from "@/components/VenueMap";

export default async function MapPage({ searchParams }: { searchParams: Promise<{ format?: string; island?: string }> }) {
  await requireUser();
  const { format, island } = await searchParams;
  const rows = await q<MapVenue & { formats: string[] }>(
    `SELECT v.id::text, v.name, ST_Y(v.location::geometry) lat, ST_X(v.location::geometry) lon, v.island, v.location_quality quality, v.is_demo demo,
            array_agg(DISTINCT a.format_code) formats, count(a.id)::int assets
     FROM venue v JOIN asset a ON a.venue_id = v.id
     WHERE v.location IS NOT NULL AND ${demoFilter("v")} AND ($1::text IS NULL OR a.format_code = $1) AND ($2::text IS NULL OR v.island = $2)
     GROUP BY v.id`, [format || null, island || null]);
  const [missing] = await q<{ n: number }>(`SELECT count(*)::int n FROM venue v WHERE location IS NULL AND ${demoFilter("v")}`);
  const formats = await q<{ code: string; name: string }>("SELECT code, name FROM media_format ORDER BY name");
  return (
    <>
      <h1>Inventory map</h1>
      <form className="inline">
        <label>Format<select name="format" defaultValue={format ?? ""}><option value="">All</option>{formats.map((f) => <option key={f.code} value={f.code}>{f.name}</option>)}</select></label>
        <label>Island<select name="island" defaultValue={island ?? ""}><option value="">All</option>{["Oahu", "Maui", "Hawaii Island", "Kauai", "Molokai", "Lanai"].map((i) => <option key={i}>{i}</option>)}</select></label>
        <button type="submit">Filter</button>
      </form>
      <MapClient venues={rows} />
      <p className="small">
        {Object.entries(FORMAT_COLORS).map(([k, c]) => <span key={k} style={{ marginRight: 12 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: c, marginRight: 4 }} />{formats.find((f) => f.code === k)?.name}</span>)}
      </p>
      <p className="small muted">{rows.length} venues shown. Dashed outline = location geocoded from address (verify on site). {missing.n} venues have no location and are not on the map (see Exceptions). Map tiles and geocoding © OpenStreetMap contributors.</p>
    </>
  );
}
