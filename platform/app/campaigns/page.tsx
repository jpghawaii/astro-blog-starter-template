import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";
import { Demo, fmt } from "@/components/ui";

export default async function Campaigns() {
  await requireUser();
  const rows = await q<{ id: string; name: string; advertiser: string; flight: string; status: string; budget_usd: string | null; bookings: number; design: string; is_demo: boolean }>(
    `SELECT c.id::text, c.name, a.name advertiser, lower(c.flight)::text || ' → ' || (upper(c.flight)-1)::text flight, c.status, c.budget_usd, c.experiment_design design, c.is_demo,
            (SELECT count(*) FROM booking b WHERE b.campaign_id=c.id)::int bookings
     FROM campaign c JOIN advertiser a ON a.id=c.advertiser_id WHERE ${demoFilter("c")} ORDER BY lower(c.flight) DESC`);
  return (
    <>
      <h1>Campaigns</h1>
      <p className="sub">Campaigns, bookings, delivery and outcomes. Import with templates/campaigns.csv and templates/bookings.csv (or the monday.com bookings board once connected).</p>
      {rows.length === 0 && <p className="notice info">No production campaigns imported yet. Real bookings currently live in monday.com and QuickBooks invoice memos (e.g. contract numbers); export them to the bookings template to measure occupancy and delivery.</p>}
      {rows.length > 0 && (
        <table><thead><tr><th>Campaign</th><th>Advertiser</th><th>Flight</th><th>Status</th><th className="n">Bookings</th><th className="n">Budget</th><th>Design</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td><Link href={`/campaigns/${r.id}`}>{r.name}</Link> <Demo on={r.is_demo} /></td><td>{r.advertiser}</td><td>{r.flight}</td><td>{r.status}</td>
            <td className="n">{r.bookings}</td><td className="n">{r.budget_usd ? `$${fmt(r.budget_usd)}` : "—"}</td><td>{r.design.replace(/_/g, " ")}</td></tr>)}</tbody></table>
      )}
    </>
  );
}
