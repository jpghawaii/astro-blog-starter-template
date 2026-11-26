import { q } from "@/lib/db";

export type Audience = "client" | "internal";

export async function sourceRows(ids: string[]) {
  if (!ids.length) return [];
  return q<{ id: string; name: string; provider: string; license_name: string | null; attribution_text: string | null; vintage: string | null; last_import: string | null }>(
    `SELECT s.id, s.name, s.provider, s.license_name, s.attribution_text,
            (SELECT source_vintage FROM import_run r WHERE r.source_id=s.id AND r.status IN ('succeeded','partial') ORDER BY id DESC LIMIT 1) vintage,
            (SELECT finished_at::date::text FROM import_run r WHERE r.source_id=s.id AND r.status IN ('succeeded','partial') ORDER BY id DESC LIMIT 1) last_import
     FROM source_dataset s WHERE s.id = ANY($1) ORDER BY s.category, s.name`, [ids]);
}

export function ModeSwitch({ audience, canInternal, base }: { audience: Audience; canInternal: boolean; base: string }) {
  return (
    <div className="noprint notice info small">
      Viewing <b>{audience === "client" ? "client-facing" : "INTERNAL"}</b> version.{" "}
      {canInternal && (audience === "client" ? <a href={`${base}?audience=internal`}>Show internal version</a> : <a href={base}>Show client version</a>)}
      {" · "}Use your browser’s Print → Save as PDF to export.
    </div>
  );
}

export async function ReportFooter({ sourceIds, audience, excluded = [], generated, hasDemo }: { sourceIds: string[]; audience: Audience; excluded?: string[]; generated: string; hasDemo: boolean }) {
  const sources = await sourceRows([...new Set(sourceIds)]);
  return (
    <div className="footer">
      {hasDemo && <p className="notice demo">This report contains SYNTHETIC DEMO DATA and must not be shared as real JPG Media figures.</p>}
      <h3>Methodology</h3>
      <ul>
        <li><b>Context indicators</b> (jobs nearby, road traffic, resident statistics) describe the surrounding area. They are not venue visitors and not ad impressions.</li>
        <li><b>Opportunity-to-see visits</b> = venue visits × share of visits passing through the screen’s viewing zone.</li>
        <li><b>Ad contacts</b> = plays × arrival rate × (dwell + spot length) × view-zone share; plays are verified proof-of-play where available, otherwise scheduled plays from loop length. One person can generate several contacts.</li>
        <li>Low / base / high values combine the low, base and high values of each uncertain input. They show sensitivity to assumptions, not a statistical confidence interval.</li>
        <li>Venue estimates are not added together to give unique reach: deduplicated reach and frequency are reported only when licensed overlap data exist.</li>
        <li>Estimates are produced by JPG Media’s documented internal models (formula version shown with each figure). They are <b>not audited or accredited</b> by any industry body.</li>
        <li>Items marked “unavailable” have no supporting data; they are never treated as zero.</li>
      </ul>
      <h3>Sources</h3>
      <table className="small"><thead><tr><th>Source</th><th>Provider</th><th>Vintage / last import</th><th>License</th></tr></thead>
        <tbody>{sources.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.provider}</td><td>{s.vintage ?? "—"}{s.last_import ? ` (imported ${s.last_import})` : ""}</td><td>{s.license_name ?? "—"}</td></tr>)}</tbody></table>
      {sources.filter((s) => s.attribution_text).map((s) => <div key={s.id} className="small">{s.attribution_text}</div>)}
      {audience === "internal" && excluded.length > 0 && (
        <div className="notice warn small"><b>Withheld from the client version (license does not permit client reporting):</b><ul>{excluded.map((x) => <li key={x}>{x}</li>)}</ul></div>
      )}
      {audience === "client" && excluded.length > 0 && <p className="small">Some figures available internally are withheld from this version under data-license terms.</p>}
      <p className="small">Generated {generated} (Hawaii time) by JPG Media Analytics.</p>
    </div>
  );
}
