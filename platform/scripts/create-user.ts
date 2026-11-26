import bcrypt from "bcryptjs";
import { Client } from "pg";
import { loadEnv } from "../lib/env";

/** npm run db:create-user -- <email> <role> [display name]   (password read from NEW_USER_PASSWORD) */
async function main() {
  loadEnv();
  const [email, role, ...name] = process.argv.slice(2);
  const pw = process.env.NEW_USER_PASSWORD;
  if (!email || !["admin", "analyst", "sales", "viewer"].includes(role) || !pw || pw.length < 12) {
    console.error("usage: NEW_USER_PASSWORD='12+ chars' npm run db:create-user -- <email> <admin|analyst|sales|viewer> [name]");
    process.exit(2);
  }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(
    `INSERT INTO app_user (email, display_name, password_hash, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, display_name=EXCLUDED.display_name`,
    [email, name.join(" ") || null, await bcrypt.hash(pw, 12), role]);
  await c.end();
  console.log(`user ${email} (${role}) saved`);
}
main();
