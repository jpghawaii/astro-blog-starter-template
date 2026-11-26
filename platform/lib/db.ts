import { Pool, QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __jpgPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__jpgPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    globalThis.__jpgPool = new Pool({ connectionString: url, max: 10 });
  }
  return globalThis.__jpgPool;
}

export async function q<T extends QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query<T>(sql, params)).rows;
}

/**
 * Demo data is isolated: it is only ever visible when ALLOW_DEMO_DATA=1 (sandbox databases).
 * Production queries add `AND <alias>.is_demo = false` via this helper; there is no silent fallback.
 */
export function demoAllowed(): boolean {
  return process.env.ALLOW_DEMO_DATA === "1";
}
export function demoFilter(alias: string): string {
  return demoAllowed() ? "true" : `${alias}.is_demo = false`;
}
