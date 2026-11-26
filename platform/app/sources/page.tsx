import { requireUser } from "@/lib/auth";
import { q } from "@/lib/db";

const yn = (v: boolean | null) => v === true ? <span className="badge b-observed">yes</span> : v === false ? <span className="badge b-bad">no</span> : <span className="badge b-assumed">unknown → blocked</span>;
const STATUS_CLASS: Record<string, string> = { tested_working: "b-observed", configured_untested: "b-assumed", needs_credentials: "b-bad", needs_subscription: "b-bad", blocked: "b-bad", not_connected: "b-neutral", not_applicable: "b-neutral" };

export default async function Sources() {
  await requireUser();
  const rows = await q<{ id: string; name: string; provider: string; category: string; access_method: string; documentation_url: string | null; license_name: string | null;
    permits_internal_analysis: boolean | null; permits_client_reports: boolean | null; permits_audience_activation: boolean | null; permits_redistribution: boolean | null;
    connection_status: string; connection_notes: string | null; connection_tested_at: string | null; geographic_coverage: string | null; notes: string | null; last_run: string | null; last_vintage: string | null }>(
    `SELECT s.*, (SELECT max(finished_at)::date::text FROM import_run r WHERE r.source_id=s.id AND r.status IN ('succeeded','partial')) last_run,
            (SELECT source_vintage FROM import_run r WHERE r.source_id=s.id AND r.status IN ('succeeded','partial') ORDER BY id DESC LIMIT 1) last_vintage
     FROM source_dataset s ORDER BY CASE category WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'venue_provided' THEN 3 WHEN 'commercial' THEN 4 ELSE 5 END, name`);
  return (
    <>
      <h1>Sources &amp; licenses</h1>
      <p className="sub">Every number in the platform names one of these sources. Connection status is only “tested working” after a successful live call (run <code>python -m ingest connection-status</code>).
        Unknown license terms block that use until the contract is reviewed and this registry is updated.</p>
      <div className="scroll"><table className="small">
        <thead><tr><th>Source</th><th>Type / access</th><th>Connection</th><th>Last import</th><th>Internal</th><th>Client reports</th><th>Activation</th><th>Redistribution</th><th>Notes</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><b>{r.name}</b><div className="muted mono">{r.id}</div><div className="muted">{r.provider}</div>{r.documentation_url && <a href={r.documentation_url}>docs</a>}</td>
            <td>{r.category}<div className="muted">{r.access_method}</div><div className="muted">{r.license_name}</div></td>
            <td><span className={`badge ${STATUS_CLASS[r.connection_status] ?? "b-neutral"}`}>{r.connection_status.replace(/_/g, " ")}</span><div className="muted">{r.connection_notes}</div>
              {r.connection_tested_at && <div className="muted">tested {new Date(r.connection_tested_at).toLocaleDateString()}</div>}</td>
            <td>{r.last_run ?? "—"}<div className="muted">{r.last_vintage}</div></td>
            <td>{yn(r.permits_internal_analysis)}</td><td>{yn(r.permits_client_reports)}</td><td>{yn(r.permits_audience_activation)}</td><td>{yn(r.permits_redistribution)}</td>
            <td>{r.geographic_coverage && <div>{r.geographic_coverage}</div>}<div className="muted">{r.notes}</div></td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="small muted">Vendor research and verification notes: docs/research/provider-research.md. Credential list: docs/CREDENTIALS_NEEDED.md.</p>
    </>
  );
}
