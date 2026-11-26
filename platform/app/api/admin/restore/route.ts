import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { audit, currentUser } from "@/lib/auth";
import { pool, q } from "@/lib/db";

/**
 * One-time data load for a fresh deployment (bundle from scripts/export-bundle.sh).
 * Guards: admin only, RESTORE_ENABLED=1 must be set, the database must contain no venues yet,
 * and the whole bundle runs in ONE transaction (all or nothing).
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user || user.role !== "admin") return new NextResponse("admin only", { status: 403 });
  if (process.env.RESTORE_ENABLED !== "1") return new NextResponse("restore disabled (set RESTORE_ENABLED=1 temporarily)", { status: 403 });
  const [{ n }] = await q<{ n: number }>("SELECT count(*)::int n FROM venue");
  if (n > 0) return NextResponse.redirect(new URL("/admin/restore?error=not-empty", req.url), 303);

  const form = await req.formData();
  const file = form.get("bundle");
  if (!(file instanceof File) || file.size === 0) return NextResponse.redirect(new URL("/admin/restore?error=no-file", req.url), 303);
  if (file.size > 50 * 1024 * 1024) return NextResponse.redirect(new URL("/admin/restore?error=too-large", req.url), 303);

  let sql: string;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    sql = (file.name.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
  } catch {
    return NextResponse.redirect(new URL("/admin/restore?error=unreadable", req.url), 303);
  }
  sql = sql.split("\n").filter((l) => !l.startsWith("\\")).join("\n"); // psql meta-commands are not SQL

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    await audit(user.id, "restore_failed", file.name, { error: (e as Error).message.slice(0, 500) });
    return NextResponse.redirect(new URL(`/admin/restore?error=${encodeURIComponent((e as Error).message.slice(0, 200))}`, req.url), 303);
  } finally {
    // The bundle changes session settings (pg_dump sets search_path to ''); never return this
    // connection to the pool — destroy it.
    client.release(true);
  }
  const [c] = await q<{ venues: number; assets: number; obs: number; invoices: number }>(
    "SELECT (SELECT count(*) FROM venue)::int venues, (SELECT count(*) FROM asset)::int assets, (SELECT count(*) FROM metric_observation)::int obs, (SELECT count(*) FROM invoice_line)::int invoices");
  await audit(user.id, "restore_bundle", file.name, c);
  return NextResponse.redirect(new URL(`/admin/restore?done=${c.venues}-${c.assets}-${c.obs}-${c.invoices}`, req.url), 303);
}
