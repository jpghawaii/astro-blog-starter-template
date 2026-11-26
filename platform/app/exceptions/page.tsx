import { revalidatePath } from "next/cache";
import { audit, CAN, requireUser } from "@/lib/auth";
import { q } from "@/lib/db";

async function resolve(formData: FormData) {
  "use server";
  const user = await requireUser(["admin", "analyst"]);
  const id = String(formData.get("id"));
  const action = String(formData.get("action"));
  const note = String(formData.get("note") || "").trim();
  const candidate = formData.get("candidate") ? String(formData.get("candidate")) : null;
  const [ex] = await q<{ entity_type: string; source_record_ref: string; candidate_ids: string[] }>("SELECT entity_type, source_record_ref, candidate_ids FROM match_exception WHERE id=$1", [id]);
  if (!ex) return;
  let resolution = note || action;
  if (action === "link" && candidate && ex.candidate_ids.map(String).includes(candidate)) {
    // Apply the analyst's chosen match. Only invoice-item links are applied automatically; other
    // entity links are recorded for the next import, which reads venue_identifier.
    if (ex.entity_type === "invoice_line" && ex.source_record_ref.startsWith("item:")) {
      await q("UPDATE invoice_line SET venue_id=$1 WHERE item_name=$2 AND is_demo=false", [candidate, ex.source_record_ref.slice(5)]);
    } else {
      await q("INSERT INTO venue_identifier (venue_id, system, external_id, external_name) VALUES ($1,'manual_match',$2,$3) ON CONFLICT (system, external_id) DO UPDATE SET venue_id=EXCLUDED.venue_id",
        [candidate, ex.source_record_ref, note || null]);
    }
    resolution = `linked to venue ${candidate}${note ? `: ${note}` : ""}`;
  }
  await q("UPDATE match_exception SET status=$2, resolution=$3, resolved_by=$4, resolved_at=now() WHERE id=$1",
    [id, action === "ignore" ? "ignored" : "resolved", resolution, user.email]);
  await audit(user.id, "resolve_exception", `match_exception:${id}`, { action, candidate, note });
  revalidatePath("/exceptions");
}

export default async function Exceptions({ searchParams }: { searchParams: Promise<{ issue?: string; status?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const status = sp.status || "open";
  const counts = await q<{ issue: string; n: number }>("SELECT issue, count(*)::int n FROM match_exception WHERE status=$1 GROUP BY 1 ORDER BY 2 DESC", [status]);
  const rows = await q<{ id: string; entity_type: string; source_id: string; source_record_ref: string; issue: string; detail: string; candidate_ids: string[]; candidate_scores: string[]; resolution: string | null; created_at: string }>(
    `SELECT id::text, entity_type, source_id, source_record_ref, issue, detail, candidate_ids::text[], candidate_scores::text[], resolution, created_at FROM match_exception
     WHERE status=$1 AND ($2::text IS NULL OR issue=$2) ORDER BY issue, id LIMIT 300`, [status, sp.issue || null]);
  const candIds = [...new Set(rows.flatMap((r) => r.candidate_ids))];
  const names = candIds.length ? await q<{ id: string; name: string }>("SELECT id::text, name FROM venue WHERE id = ANY($1::bigint[])", [candIds]) : [];
  const canResolve = CAN.resolveExceptions(user.role);
  return (
    <>
      <h1>Data exceptions</h1>
      <p className="sub">Uncertain matches, missing coordinates, conflicts and invalid rows. Nothing here is fixed silently: an analyst resolves or ignores each item, and the decision is audited.</p>
      <form className="inline">
        <label>Status<select name="status" defaultValue={status}><option>open</option><option>resolved</option><option>ignored</option></select></label>
        <label>Issue<select name="issue" defaultValue={sp.issue ?? ""}><option value="">All</option>{counts.map((c) => <option key={c.issue} value={c.issue}>{c.issue} ({c.n})</option>)}</select></label>
        <button>Filter</button>
      </form>
      <div className="grid" style={{ marginBottom: 12 }}>{counts.map((c) => <div className="card" key={c.issue}><div className="k">{c.issue.replace(/_/g, " ")}</div><div className="v">{c.n}</div></div>)}</div>
      <div className="scroll"><table className="small">
        <thead><tr><th>Issue</th><th>Record</th><th>Detail</th><th>{status === "open" ? "Action" : "Resolution"}</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td><span className="badge b-assumed">{r.issue.replace(/_/g, " ")}</span><div className="muted">{r.entity_type} · {r.source_id}</div></td>
            <td className="mono">{r.source_record_ref}</td><td>{r.detail}</td>
            <td>{status !== "open" ? r.resolution : canResolve ? (
              <form action={resolve} style={{ display: "grid", gap: 4, minWidth: 220 }}>
                <input type="hidden" name="id" value={r.id} />
                {r.candidate_ids.length > 0 && <select name="candidate">{r.candidate_ids.map((c, i) => <option key={c} value={c}>{names.find((n) => n.id === c)?.name ?? c} ({r.candidate_scores[i]})</option>)}</select>}
                <input name="note" placeholder="note / evidence" />
                <div style={{ display: "flex", gap: 4 }}>
                  {r.candidate_ids.length > 0 && <button name="action" value="link">Link</button>}
                  <button name="action" value="resolve" className="secondary">Resolved</button>
                  <button name="action" value="ignore" className="secondary">Ignore</button>
                </div>
              </form>) : <span className="muted">analyst role required</span>}</td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}
