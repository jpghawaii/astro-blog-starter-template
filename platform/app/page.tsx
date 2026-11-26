import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";
import { fmt } from "@/components/ui";

export default async function Overview({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  await requireUser();
  const { denied } = await searchParams;
  const [tot] = await q<{ venues: number; located: number; assets: number; digital: number; operating: number; unverified: number }>(
    `SELECT (SELECT count(*) FROM venue v WHERE ${demoFilter("v")})::int venues,
            (SELECT count(*) FROM venue v WHERE location IS NOT NULL AND ${demoFilter("v")})::int located,
            count(*)::int assets, count(*) FILTER (WHERE is_digital)::int digital,
            count(*) FILTER (WHERE status='operating')::int operating, count(*) FILTER (WHERE status='unverified')::int unverified
     FROM asset a WHERE ${demoFilter("a")}`);
  const byFormat = await q<{ name: string; code: string; island: string | null; n: number }>(
    `SELECT f.name, f.code, v.island, count(*)::int n FROM asset a JOIN media_format f ON f.code=a.format_code JOIN venue v ON v.id=a.venue_id
     WHERE ${demoFilter("a")} GROUP BY 1,2,3 ORDER BY 1,3`);
  const islands = [...new Set(byFormat.map((r) => r.island ?? "Unknown"))].sort();
  const formats = [...new Set(byFormat.map((r) => r.name))];
  const [exc] = await q<{ open: number }>("SELECT count(*)::int open FROM match_exception WHERE status='open'");
  const runs = await q<{ id: number; source_id: string; adapter: string; status: string; finished_at: string; source_vintage: string | null; rows_inserted: number; rows_updated: number; rows_unchanged: number; rows_rejected: number }>(
    "SELECT id, source_id, adapter, status, finished_at, source_vintage, rows_inserted, rows_updated, rows_unchanged, rows_rejected FROM import_run ORDER BY id DESC LIMIT 6");
  const [ctx] = await q<{ n: number }>("SELECT count(DISTINCT subject_id)::int n FROM metric_observation m WHERE metric_code LIKE 'workers_within_%' AND " + demoFilter("m"));

  return (
    <>
      {denied && <p className="notice bad">Your role does not have access to that page.</p>}
      <h1>Network overview</h1>
      <p className="sub">Inventory counts come from imported records and are <b>unverified</b> until each asset is confirmed against installed-player and venue-contract records.</p>
      <div className="grid">
        <div className="card"><div className="k">Venues</div><div className="v">{fmt(tot.venues)}</div><div className="small muted">{fmt(tot.located)} with a location</div></div>
        <div className="card"><div className="k">Assets (faces / screens)</div><div className="v">{fmt(tot.assets)}</div><div className="small muted">{fmt(tot.digital)} digital</div></div>
        <div className="card"><div className="k">Status: operating</div><div className="v">{fmt(tot.operating)}</div><div className="small muted">per source sheet, {fmt(tot.unverified)} unverified</div></div>
        <div className="card"><div className="k">Venues with public-data profile</div><div className="v">{fmt(ctx.n)}</div><div className="small muted">LODES8 2024 jobs nearby</div></div>
        <div className="card"><div className="k">Open data exceptions</div><div className="v">{fmt(exc.open)}</div><div className="small"><Link href="/exceptions">Review queue →</Link></div></div>
      </div>

      <h2>Assets by format and island</h2>
      <div className="scroll"><table>
        <thead><tr><th>Format</th>{islands.map((i) => <th key={i} className="n">{i}</th>)}<th className="n">Total</th></tr></thead>
        <tbody>{formats.map((f) => {
          const rows = byFormat.filter((r) => r.name === f);
          return <tr key={f}><td>{f}</td>{islands.map((i) => <td key={i} className="n">{fmt(rows.filter((r) => (r.island ?? "Unknown") === i).reduce((s, r) => s + r.n, 0))}</td>)}
            <td className="n"><b>{fmt(rows.reduce((s, r) => s + r.n, 0))}</b></td></tr>;
        })}</tbody>
      </table></div>
      <p className="small muted">“Unknown” island = venue has neither coordinates nor a ZIP code; see the exceptions queue.
        Sellable capacity is not the same as asset count: digital screens sell slots in a loop; see <Link href="/inventory">Availability</Link>.</p>

      <h2>Recent imports</h2>
      <div className="scroll"><table className="small">
        <thead><tr><th>#</th><th>Source</th><th>Adapter</th><th>Vintage</th><th>Status</th><th className="n">Inserted</th><th className="n">Updated</th><th className="n">Unchanged</th><th className="n">Rejected</th><th>Finished</th></tr></thead>
        <tbody>{runs.map((r) => <tr key={r.id}><td>{r.id}</td><td className="mono">{r.source_id}</td><td className="mono">{r.adapter}</td><td>{r.source_vintage ?? "—"}</td>
          <td><span className={`badge ${r.status === "succeeded" ? "b-observed" : r.status === "partial" ? "b-assumed" : "b-bad"}`}>{r.status}</span></td>
          <td className="n">{r.rows_inserted}</td><td className="n">{r.rows_updated}</td><td className="n">{r.rows_unchanged}</td><td className="n">{r.rows_rejected}</td>
          <td>{r.finished_at ? new Date(r.finished_at).toLocaleString("en-US", { timeZone: "Pacific/Honolulu" }) : "running"}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}
