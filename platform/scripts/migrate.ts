import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { loadEnv } from "../lib/env";

/** Applies db/migrations/*.sql in lexical order, each in its own transaction. Idempotent. */
export async function migrate(databaseUrl: string, log = console.log) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT version FROM schema_migration")).rows.map((r) => r.version));
    const dir = join(__dirname, "..", "db", "migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql.replace(/CREATE TABLE schema_migration[\s\S]*?\);\s*$/m, ""));
        await client.query("INSERT INTO schema_migration(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`applied ${file}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  loadEnv();
  const url = process.argv[2] === "--test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set (see .env.example)");
  migrate(url).then(() => console.log("migrations complete"));
}
