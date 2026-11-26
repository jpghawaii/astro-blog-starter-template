import { requireUser } from "@/lib/auth";
import { q } from "@/lib/db";
import { fmt } from "@/components/ui";

export default async function Methodology() {
  await requireUser();
  const defs = await q<{ code: string; version: number; name: string; unit: string; definition: string; formula: string | null; cautions: string | null }>(
    "SELECT code, version, name, unit, definition, formula, cautions FROM metric_definition WHERE is_current ORDER BY code");
  const asm = await q<{ code: string; applies_to: string; description: string; unit: string; low_value: string; base_value: string; high_value: string; rationale: string; status: string; reviewed_by: string | null }>(
    "SELECT * FROM model_assumption ORDER BY applies_to, code");
  return (
    <>
      <h1>Measurement methodology</h1>
      <p className="sub">Full text: docs/METHODOLOGY.md. Models live in lib/measurement and are covered by unit tests with hand-computed values.</p>
      <div className="card">
        <h3>The measurement ladder (never collapsed into one number)</h3>
        <ol>
          <li><b>Venue visits</b>: people entering a venue (door counts, transactions, vendor visits). Not exposure.</li>
          <li><b>Opportunity to see</b>: visits that pass through the asset’s viewing zone.</li>
          <li><b>Ad contacts</b>: digital = plays × arrival rate × (dwell + spot length) × view-zone share; static = format-specific (fueling transactions, checkout transactions, passing traffic).</li>
          <li><b>Estimated impressions</b>: contacts × a notice/attention factor, only when such a factor is supplied and labelled.</li>
          <li><b>Unique reach / frequency</b>: only from licensed overlap data for the exact venue set; otherwise unavailable.</li>
          <li><b>Verified ad plays</b>: proof-of-play records (observed). Scheduled plays are labelled as such.</li>
          <li><b>Outcomes</b>: observed events → attributed (tagged, within a declared window) → incremental lift (declared control design only).</li>
        </ol>
        <p className="small">Statuses: <b>observed</b> (measured count), <b>vendor-modeled</b> (provider estimate), <b>internal model</b> (our formula), <b>assumption</b> (planning value with low/base/high and rationale), <b>unavailable</b> (no data; never zero).
          Low/base/high combine input ranges; they are not confidence intervals. JPG Media’s models are not audited or accredited by any industry body.</p>
      </div>
      <h2>Metric definitions</h2>
      <div className="scroll"><table className="small"><thead><tr><th>Code</th><th>Name</th><th>Unit</th><th>Definition</th><th>Formula</th><th>Cautions</th></tr></thead>
        <tbody>{defs.map((d) => <tr key={d.code + d.version}><td className="mono">{d.code} v{d.version}</td><td>{d.name}</td><td>{d.unit}</td><td>{d.definition}</td><td className="mono">{d.formula}</td><td>{d.cautions}</td></tr>)}</tbody></table></div>
      <h2>Assumptions register</h2>
      <div className="scroll"><table className="small"><thead><tr><th>Assumption</th><th>Format</th><th className="n">Low</th><th className="n">Base</th><th className="n">High</th><th>Unit</th><th>Rationale</th><th>Reviewed</th></tr></thead>
        <tbody>{asm.map((a) => <tr key={a.code + a.applies_to}><td><b>{a.code}</b><div className="muted">{a.description}</div></td><td>{a.applies_to}</td>
          <td className="n">{fmt(a.low_value, 2)}</td><td className="n">{fmt(a.base_value, 2)}</td><td className="n">{fmt(a.high_value, 2)}</td><td>{a.unit}</td><td>{a.rationale}</td><td>{a.reviewed_by ?? <span className="badge b-assumed">not yet reviewed</span>}</td></tr>)}</tbody></table></div>
    </>
  );
}
