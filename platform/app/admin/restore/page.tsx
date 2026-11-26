import { requireUser } from "@/lib/auth";
import { q } from "@/lib/db";

export default async function Restore({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  await requireUser(["admin"]);
  const { done, error } = await searchParams;
  const [{ n }] = await q<{ n: number }>("SELECT count(*)::int n FROM venue");
  const enabled = process.env.RESTORE_ENABLED === "1";
  const [v, a, o, i] = (done ?? "").split("-");
  return (
    <>
      <h1>Load data bundle</h1>
      <p className="sub">One-time load of the data prepared during setup (<code>jpg-data-bundle-*.sql.gz</code>). Runs as a single transaction: either everything loads or nothing does.</p>
      {done && <p className="notice info">Loaded {v} venues, {a} assets, {o} observations and {i} invoice lines. Now set <code>RESTORE_ENABLED=0</code> in Render and redeploy.</p>}
      {error && <p className="notice bad">Not loaded: {error === "not-empty" ? "the database already contains venues." : error}</p>}
      {!enabled && <p className="notice warn">Restore is switched off. Set the environment variable <code>RESTORE_ENABLED=1</code> on the web service, then reload this page.</p>}
      {enabled && n > 0 && !done && <p className="notice warn">The database already contains {n} venues; restore is only allowed into an empty database.</p>}
      {enabled && n === 0 && (
        <form action="/api/admin/restore" method="post" encType="multipart/form-data" className="card" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
          <label>Bundle file (.sql.gz)<input type="file" name="bundle" accept=".gz,.sql" required /></label>
          <button type="submit">Load data</button>
        </form>
      )}
    </>
  );
}
