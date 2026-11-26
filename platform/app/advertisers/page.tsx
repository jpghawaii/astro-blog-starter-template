import { CAN, requireUser } from "@/lib/auth";
import { demoFilter, q } from "@/lib/db";
import { AdvertiserSignals, FormatSupply, recommend } from "@/lib/targeting";
import { Demo, fmt } from "@/components/ui";

export default async function Advertisers({ searchParams }: { searchParams: Promise<{ industry?: string }> }) {
  const user = await requireUser();
  const { industry } = await searchParams;
  const showRevenue = CAN.viewRevenue(user.role);
  const showContacts = CAN.viewContacts(user.role);
  const supply = await q<FormatSupply & { formatName: string }>(
    `SELECT f.code format, f.name "formatName", count(a.id)::int units,
            count(DISTINCT m.subject_id)::int "venuesWithContext",
            percentile_cont(0.5) WITHIN GROUP (ORDER BY m.value) "medianJobs800",
            percentile_cont(0.5) WITHIN GROUP (ORDER BY a.rate_4wk_usd) "typical4wkPrice"
     FROM media_format f LEFT JOIN asset a ON a.format_code=f.code AND a.status <> 'removed' AND ${demoFilter("a")}
     LEFT JOIN metric_observation m ON m.subject_type='venue' AND m.subject_id=a.venue_id::text AND m.metric_code='workers_within_800m'
     GROUP BY 1,2`);
  const rows = await q<{ id: string; name: string; industry: string | null; sources: string[]; stage: string | null; priority: string | null; interest: string | null;
    deal: string | null; rev12: string | null; last_inv: string | null; contacts: number; is_demo: boolean }>(
    `SELECT a.id::text, a.name, a.industry, a.is_demo,
            array_remove(array[a.source_id] || (SELECT array_agg(DISTINCT system) FROM advertiser_identifier i WHERE i.advertiser_id=a.id), NULL) sources,
            p.inputs->>'stage' stage, p.inputs->>'priority' priority, p.inputs->>'inventory_interest' interest, p.value deal,
            (SELECT sum(amount_usd) FROM invoice_line l WHERE l.advertiser_id=a.id AND l.revenue_class='media' AND l.txn_date > now() - interval '12 months') rev12,
            (SELECT max(txn_date)::text FROM invoice_line l WHERE l.advertiser_id=a.id) last_inv,
            (SELECT count(*) FROM advertiser_contact c WHERE c.advertiser_id=a.id)::int contacts
     FROM advertiser a LEFT JOIN metric_observation p ON p.subject_type='network' AND p.subject_id='advertiser:'||a.id AND p.metric_code='crm_pipeline'
     WHERE ${demoFilter("a")} AND ($1::text IS NULL OR a.industry=$1)`, [industry || null]);
  const recs = rows.map((r) => recommend({
    id: r.id, name: r.name, industry: r.industry, inventoryInterest: r.interest ? r.interest.split(",").map((s) => s.trim()) : [],
    crmStage: r.stage, crmPriority: r.priority, estDealValue: r.deal ? Number(r.deal) : null,
    mediaRevenue12m: showRevenue && r.rev12 ? Number(r.rev12) : null, lastInvoiceDate: showRevenue ? r.last_inv : null,
    hasAuthorizedContact: r.contacts > 0, sources: r.sources,
  } as AdvertiserSignals, supply)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const contacts = showContacts ? await q<{ advertiser_id: string; full_name: string | null; role: string | null; email: string | null; phone: string | null; linkedin_url: string | null; source_id: string }>(
    "SELECT advertiser_id::text, full_name, role, email, phone, linkedin_url, source_id FROM advertiser_contact") : [];
  const industries = [...new Set(rows.map((r) => r.industry).filter(Boolean))] as string[];
  return (
    <>
      <h1>Advertiser recommendations</h1>
      <p className="sub">Ranks businesses already in JPG systems (CRM board, QuickBooks customers, licensed exports) by fit with available inventory. Each score is explained;
        inputs that are missing are shown as unavailable and excluded from the score rather than counted as zero. Contextual recommendations only — no individual-level targeting.</p>
      <form className="inline"><label>Industry<select name="industry" defaultValue={industry ?? ""}><option value="">All</option>{industries.map((i) => <option key={i}>{i}</option>)}</select></label><button>Filter</button></form>
      {!showRevenue && <p className="notice info small">Billing history is hidden for your role; the relationship score uses CRM data only.</p>}
      <div className="scroll"><table>
        <thead><tr><th>Advertiser</th><th>Industry</th><th className="n">Score</th><th>Recommended formats</th><th>Why</th><th>Contact</th></tr></thead>
        <tbody>{recs.map((r) => {
          const a = r.advertiser;
          const cs = contacts.filter((c) => c.advertiser_id === a.id);
          return (
            <tr key={a.id}>
              <td><b>{a.name}</b> <Demo on={rows.find((x) => x.id === a.id)!.is_demo} /><div className="muted small">sources: {a.sources.join(", ")}</div></td>
              <td>{a.industry ?? <span className="badge b-unavailable">unknown</span>}</td>
              <td className="n">{r.score == null ? <span className="badge b-unavailable">unavailable</span> : <b>{r.score}</b>}</td>
              <td className="small">{r.bestFormats.length ? r.bestFormats.map((b) => <div key={b.format}>{b.formatName} <span className="muted">({b.units} units)</span></div>) : <span className="muted">—</span>}</td>
              <td className="small">
                <ul style={{ margin: 0, paddingLeft: 16 }}>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
                <details><summary>score breakdown</summary><table className="small"><tbody>{r.components.map((c) => <tr key={c.name}><td>{c.name} <span className="muted">w={c.weight}</span></td><td className="n">{c.score == null ? "unavailable" : fmt(c.score, 2)}</td><td>{c.reason}</td></tr>)}</tbody></table>
                  <div className="muted">{r.cautions.join(" ")}</div></details>
              </td>
              <td className="small">{!showContacts ? <span className="muted">hidden for role</span> : cs.length ? cs.map((c, i) => <div key={i}>{c.full_name ?? ""} {c.role ? `(${c.role})` : ""} {c.email ?? ""} {c.phone ?? ""} {c.linkedin_url?.startsWith("http") ? <a href={c.linkedin_url}>LinkedIn</a> : ""}<span className="muted"> · {c.source_id}</span></div>) : <span className="muted">none authorized</span>}</td>
            </tr>);
        })}</tbody>
      </table></div>
      <p className="small muted">Category fit uses the documented JPG heuristic matrix in lib/targeting.ts (v1), a sales judgment rather than measured response. Venue context = median LEHD jobs within 800 m of venues carrying the format.
        New prospects can be added from a licensed Apollo export (<code>python -m ingest import-provider</code>) or the CRM; audience activation is only possible through licensed, approved destinations.</p>
    </>
  );
}
