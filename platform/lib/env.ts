import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal .env.local loader for CLI scripts (Next.js loads it itself for the app). */
export function loadEnv(dir = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  }
}
