import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";
import { Demo, fmt } from "@/components/ui";

export default async function Venues({ searchParams }: { searchParams: Promise<{ q?: string; island?: string; type?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const rows = await q<{ id: string; name: string; venue_type: string; island: string | null; city: string | null; address: string | null; location_quality: string; assets: number; formats: string; jobs800: string | null; aadt: string | null; is_demo: boolean }>(
    `SELECT v.id::text, v.name, v.venue_type, v.island, v.city, v.address, v.location_quality, v.is_demo,
            (SELECT count(*) FROM asset a WHERE a.venue_id=v.id)::int assets,
            (SELECT string_agg(DISTINCT f.name, ', ') FROM asset a JOIN media_format f ON f.code=a.format_code WHERE a.venue_id=v.id) formats,
            (SELECT value FROM metric_observation m WHERE m.subject_type='venue' AND m.subject_id=v.id::text AND m.metric_code='workers_within_800m' ORDER BY period_end DESC LIMIT 1) jobs800,
            (SELECT value FROM metric_observation m WHERE m.subject_type='venue' AND m.subject_id=v.id::text AND m.metric_code='aadt_nearest_road' LIMIT 1) aadt
     FROM venue v WHERE ${demoFilter("v")} AND ($1::text IS NULL OR v.name ILIKE '%'||$1||'%') AND ($2::text IS NULL OR v.island=$2) AND ($3::text IS NULL OR v.venue_type=$3)
     ORDER BY v.island NULLS LAST, v.name`, [sp.q || null, sp.island || null, sp.type || null]);
  return (
    <>
      <h1>Venues</h1>
      <form className="inline">
        <label>Search<input name="q" defaultValue={sp.q} /></label>
        <label>Island<select name="island" defaultValue={sp.island ?? ""}><option value="">All</option>{["Oahu", "Maui", "Hawaii Island", "Kauai", "Molokai", "Lanai"].map((i) => <option key={i}>{i}</option>)}</select></label>
        <label>Type<select name="type" defaultValue={sp.type ?? ""}><option value="">All</option>{["gas_station", "grocery", "hotel", "shopping_center", "transit_fleet"].map((i) => <option key={i} value={i}>{i.replace("_", " ")}</option>)}</select></label>
        <button type="submit">Apply</button>
        <a className="btn secondary" href={`/api/export/venues?${new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][])}`}>Export CSV</a>
      </form>
      <div className="scroll"><table>
        <thead><tr><th>Venue</th><th>Island</th><th>Type</th><th>Formats</th><th className="n">Assets</th><th className="n">Jobs ≤800 m<br /><span className="muted">LODES 2024</span></th><th className="n">AADT nearest road<br /><span className="muted">HPMS 2024</span></th><th>Location</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td><Link href={`/venues/${r.id}`}>{r.name}</Link> <Demo on={r.is_demo} /><div className="muted small">{r.address ?? "no address"}</div></td>
            <td>{r.island ?? <span className="badge b-unavailable">unknown</span>}</td><td>{r.venue_type.replace("_", " ")}</td><td className="small">{r.formats}</td>
            <td className="n">{r.assets}</td><td className="n">{fmt(r.jobs800)}</td><td className="n">{fmt(r.aadt)}</td>
            <td><span className={`badge ${r.location_quality === "missing" ? "b-unavailable" : r.location_quality === "geocoded_address" ? "b-assumed" : "b-observed"}`}>{r.location_quality.replace("_", " ")}</span></td></tr>
        ))}</tbody>
      </table></div>
      <p className="small muted">{rows.length} venues. “unavailable” means no data, not zero.</p>
    </>
  );
}
