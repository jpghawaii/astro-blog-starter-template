import type { Estimate } from "@/lib/measurement/types";

export const fmt = (n: number | string | null | undefined, digits = 0) =>
  n == null || n === "" ? "unavailable" : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const pct = (n: number | null | undefined, digits = 1) => (n == null ? "unavailable" : `${(n * 100).toFixed(digits)}%`);

const LABEL: Record<string, string> = {
  observed: "observed", vendor_modeled: "vendor-modeled", internally_modeled: "internal model", assumed: "assumption", unavailable: "unavailable",
};
export function Status({ s }: { s: string }) {
  return <span className={`badge b-${s}`}>{LABEL[s] ?? s}</span>;
}
export function Demo({ on }: { on: boolean }) {
  return on ? <span className="badge b-demo" title="Synthetic demonstration data">DEMO</span> : null;
}
export function Flags({ flags }: { flags: string[] | null | undefined }) {
  if (!flags?.length) return null;
  return <>{flags.map((f) => <span key={f} className="badge b-assumed" style={{ marginLeft: 4 }}>{f.replace(/_/g, " ")}</span>)}</>;
}

/** Renders an Estimate with its scenarios, formula and every traced input. */
export function EstimateView({ e, showInputs = true, open = false }: { e: Estimate; showInputs?: boolean; open?: boolean }) {
  if (!e.values) {
    return (
      <div>
        <Status s="unavailable" /> <span className="muted small">{e.unavailableReason}</span>
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
        <span><span className="muted small">low</span> <b>{fmt(e.values.low)}</b></span>
        <span><span className="muted small">base</span> <b style={{ fontSize: 18 }}>{fmt(e.values.base)}</b></span>
        <span><span className="muted small">high</span> <b>{fmt(e.values.high)}</b></span>
        <span className="muted small">{e.unit} · {e.metric === "est_impressions" ? "attention-adjusted impressions" : "opportunity-to-see contacts"}</span>
        <Status s={e.status} />
      </div>
      {e.warnings.map((w) => <div key={w} className="small" style={{ color: "var(--warn-ink)" }}>⚠ {w}</div>)}
      {showInputs && (
        <details open={open}>
          <summary className="small">Formula and inputs (v{e.metricVersion})</summary>
          <p className="mono small">{e.formula}</p>
          <div className="scroll"><table className="small">
            <thead><tr><th>Input</th><th className="n">Low</th><th className="n">Base</th><th className="n">High</th><th>Unit</th><th>Status</th><th>Source</th><th>Period / as of</th></tr></thead>
            <tbody>{e.inputs.map((i, k) => (
              <tr key={k}><td>{i.label}<div className="muted mono">{i.code}</div></td>
                <td className="n">{fmt(i.values.low, 3)}</td><td className="n">{fmt(i.values.base, 3)}</td><td className="n">{fmt(i.values.high, 3)}</td>
                <td>{i.unit}</td><td><Status s={i.status} /></td><td className="mono">{i.sourceId}<div className="muted">{i.sourceRef}</div></td>
                <td>{i.periodStart ? `${i.periodStart} → ${i.periodEnd}` : i.asOf ?? "—"}{i.sampleSize != null && <div className="muted">n={i.sampleSize}</div>}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="muted small">{e.scenarioNote}</p>
        </details>
      )}
    </div>
  );
}
