import type { MarketContext } from "@/lib/market";
import { fmt, Flags, Status } from "./ui";

const VISITOR_LABEL: Record<string, string> = {
  visitor_avg_daily_census: "Visitors present on the island per day (average)",
  visitor_arrivals: "Visitor arrivals in the month",
  visitor_days: "Visitor days in the month",
  visitor_avg_length_of_stay: "Average length of stay (days)",
  visitor_spend_per_person_day: "Visitor spending per person per day (USD)",
  visitor_expenditures: "Visitor spending in the month (USD millions)",
};

export function MarketContextView({ m }: { m: MarketContext }) {
  const month = m.visitors[0]?.period_start?.slice(0, 7);
  return (
    <>
      <h3>Island visitors {month && <span className="muted small">({m.island}, {month}, DBEDT preliminary)</span>}</h3>
      {m.visitors.length ? (
        <table className="small"><tbody>{m.visitors.map((o) => (
          <tr key={o.metric_code}><td>{VISITOR_LABEL[o.metric_code] ?? o.metric_code}</td><td className="n">{o.value == null ? <Status s="unavailable" /> : fmt(o.value, o.metric_code.includes("stay") || o.metric_code.includes("expend") ? 1 : 0)}</td></tr>
        ))}</tbody></table>
      ) : <p className="small muted">Unavailable: venue island unknown or visitor statistics not imported.</p>}
      <p className="small muted">Island-wide visitor statistics: they describe the visitor market on the island, not visitors to this venue.</p>

      <h3>Businesses in ZIP {m.zip ?? "—"} {m.zipSource && <span className="muted small">(from {m.zipSource}; Census ZIP Business Patterns {m.businesses[0]?.period_start?.slice(0, 4) ?? ""})</span>}</h3>
      {m.businesses.length ? (
        <table className="small"><tbody>{m.businesses.map((b) => <tr key={b.subject_id}><td>{b.geo_scope.split("), ")[1] ?? b.geo_scope}</td><td className="n">{fmt(b.value)}</td></tr>)}</tbody></table>
      ) : <p className="small muted">Unavailable for this venue.</p>}

      <h3>County private-sector industries <span className="muted small">(BLS QCEW {m.industries[0]?.jobs?.period_start?.slice(0, 7) ?? ""} quarter)</span></h3>
      {m.industries.length ? (
        <table className="small"><thead><tr><th>Industry</th><th className="n">Jobs</th><th className="n">Establishments</th><th className="n">Avg weekly wage</th></tr></thead>
          <tbody>{m.industries.map((i) => <tr key={i.sector}><td>{i.sector}<Flags flags={i.jobs?.quality_flags} /></td><td className="n">{fmt(i.jobs?.value)}</td><td className="n">{fmt(i.estabs?.value)}</td><td className="n">{i.wage?.value ? `$${fmt(i.wage.value)}` : "unavailable"}</td></tr>)}</tbody></table>
      ) : <p className="small muted">Unavailable: venue county unknown.</p>}
      <p className="small muted">“Suppressed” cells are withheld by BLS for confidentiality and shown as unavailable, never zero.</p>
    </>
  );
}
