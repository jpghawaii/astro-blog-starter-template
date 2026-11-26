import { requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";
import { occupancy, CapacityRow, BookingRow, CapacityUnit } from "@/lib/inventory/occupancy";
import { pct, fmt } from "@/components/ui";

export default async function Inventory({ searchParams }: { searchParams: Promise<{ start?: string; end?: string; format?: string; island?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const start = sp.start || today;
  const end = sp.end || new Date(Date.parse(start) + 27 * 86_400_000).toISOString().slice(0, 10);
  const formats = await q<{ code: string; name: string; capacity_unit: CapacityUnit }>("SELECT code, name, capacity_unit FROM media_format ORDER BY name");
  const assets = await q<{ id: string; format_code: string; status: string; island: string | null }>(
    `SELECT a.id::text, a.format_code, a.status, v.island FROM asset a JOIN venue v ON v.id=a.venue_id WHERE ${demoFilter("a")} AND a.status <> 'removed'
     AND ($1::text IS NULL OR a.format_code=$1) AND ($2::text IS NULL OR v.island=$2)`, [sp.format || null, sp.island || null]);
  const cap = await q<CapacityRow & { assetId: string }>(
    `SELECT asset_id::text "assetId", lower(period)::text start, (upper(period) - 1)::text "end", unit, capacity::float capacity FROM capacity_period c
     WHERE period && daterange($1::date, $2::date, '[]') AND ${demoFilter("c")}`, [start, end]);
  const bk = await q<BookingRow>(
    `SELECT asset_id::text "assetId", lower(period)::text start, (upper(period) - 1)::text "end", unit, units_booked::float units, status FROM booking b
     WHERE period && daterange($1::date, $2::date, '[]') AND ${demoFilter("b")}`, [start, end]);
  const rows = formats.map((f) => {
    const ids = assets.filter((a) => a.format_code === f.code).map((a) => a.id);
    return { f, ids, r: ids.length ? occupancy(ids, cap, bk, { start, end }, f.capacity_unit) : null };
  }).filter((x) => x.ids.length);
  return (
    <>
      <h1>Availability &amp; occupancy</h1>
      <p className="sub">Occupancy = booked capacity-unit-days ÷ available capacity-unit-days in the range. Digital screens are measured in <b>spot slots</b> (sellable advertiser positions in the loop);
        static faces in <b>face-periods</b>. Bookings are the basis — invoices are not proof of occupancy or delivery.</p>
      <form className="inline">
        <label>From<input type="date" name="start" defaultValue={start} /></label><label>To<input type="date" name="end" defaultValue={end} /></label>
        <label>Format<select name="format" defaultValue={sp.format ?? ""}><option value="">All</option>{formats.map((f) => <option key={f.code} value={f.code}>{f.name}</option>)}</select></label>
        <label>Island<select name="island" defaultValue={sp.island ?? ""}><option value="">All</option>{["Oahu", "Maui", "Hawaii Island", "Kauai"].map((i) => <option key={i}>{i}</option>)}</select></label>
        <button>Apply</button>
      </form>
      <div className="scroll"><table>
        <thead><tr><th>Format</th><th>Unit</th><th className="n">Assets</th><th className="n">Assets with capacity defined</th><th className="n">Capacity unit-days</th><th className="n">Booked</th><th className="n">Holds</th><th>Occupancy</th><th>Notes</th></tr></thead>
        <tbody>{rows.map(({ f, ids, r }) => (
          <tr key={f.code}><td>{f.name}</td><td className="mono">{f.capacity_unit}</td><td className="n">{ids.length}</td><td className="n">{ids.length - (r?.assetsWithoutCapacity.length ?? 0)}</td>
            <td className="n">{fmt(r?.capacityUnitDays)}</td><td className="n">{fmt(r?.bookedUnitDays)}</td><td className="n">{fmt(r?.holdUnitDays)}</td>
            <td style={{ minWidth: 140 }}>{r?.occupancy == null ? <span className="badge b-unavailable">unavailable</span> : <><div className="bar"><span style={{ width: `${Math.min(100, r.occupancy * 100)}%` }} /></div>{pct(r.occupancy)} <span className="muted small">incl. holds {pct(r.occupancyInclHolds)}</span></>}</td>
            <td className="small">{r?.warnings.map((w) => <div key={w}>{w}</div>)}</td></tr>
        ))}</tbody>
      </table></div>
      <p className="small muted">Digital capacity requires the loop length and sellable slots per loop from the CMS schedule; until supplied (capacity template), occupancy for those screens is unavailable rather than 0%.
        No production bookings have been imported yet: load them with <code>python -m ingest import-template bookings &lt;file&gt;</code> (templates/bookings.csv) or from the monday.com bookings board once its token is configured.</p>
    </>
  );
}
