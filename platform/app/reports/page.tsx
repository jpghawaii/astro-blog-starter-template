import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";

export default async function Reports() {
  await requireUser();
  const venues = await q<{ id: string; name: string; island: string | null }>(`SELECT v.id::text, v.name, v.island FROM venue v WHERE ${demoFilter("v")} ORDER BY island NULLS LAST, name`);
  const campaigns = await q<{ id: string; name: string; adv: string; is_demo: boolean }>(
    `SELECT c.id::text, c.name, a.name adv, c.is_demo FROM campaign c JOIN advertiser a ON a.id=c.advertiser_id WHERE ${demoFilter("c")} ORDER BY c.id DESC`);
  return (
    <>
      <h1>Reports</h1>
      <p className="sub">Client-facing by default: data whose license does not permit client reporting is removed automatically and the methodology and source dates are attached.</p>
      <div className="grid">
        <div className="card"><b>Network overview</b><p className="small">Inventory by format and island, location coverage, area context.</p><Link className="btn" href="/reports/network">Open</Link></div>
        <div className="card"><b>Venue media sheet / audience profile</b>
          <form action="/reports/go" style={{ display: "grid", gap: 6, marginTop: 6 }}>
            <select name="venue">{venues.map((v) => <option key={v.id} value={v.id}>{v.island ?? "?"} · {v.name}</option>)}</select>
            <div style={{ display: "flex", gap: 6 }}><button name="kind" value="media-sheet">Media sheet</button><button name="kind" value="audience" className="secondary">Audience profile</button></div>
          </form></div>
        <div className="card"><b>Campaign proposal / delivery &amp; outcome</b>
          {campaigns.length ? <ul className="small">{campaigns.map((c) => <li key={c.id}>{c.adv}: {c.name}{c.is_demo ? " (DEMO)" : ""} — <Link href={`/reports/proposal/${c.id}`}>proposal</Link> · <Link href={`/reports/delivery/${c.id}`}>delivery</Link></li>)}</ul>
            : <p className="small muted">No campaigns imported yet. Import bookings with the campaign template (templates/bookings.csv).</p>}</div>
      </div>
    </>
  );
}
