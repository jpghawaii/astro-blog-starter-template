import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { q } from "./db";

export type Role = "admin" | "analyst" | "sales" | "viewer";
export interface User { id: number; email: string; display_name: string | null; role: Role }

export const COOKIE = "jpg_session";
const TTL_HOURS = 12;
const DUMMY_HASH = bcrypt.hashSync("timing-equalizer-not-a-password", 10);

/** What each role may see. Confidential records (revenue, CRM contacts, licensed vendor data) need analyst+. */
export const CAN = {
  viewRevenue: (r: Role) => r === "admin" || r === "analyst",
  viewContacts: (r: Role) => r === "admin" || r === "analyst" || r === "sales",
  viewRestrictedSources: (r: Role) => r === "admin" || r === "analyst",
  resolveExceptions: (r: Role) => r === "admin" || r === "analyst",
  manageUsers: (r: Role) => r === "admin",
};

function tokenHash(token: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET must be set (16+ chars)");
  return createHash("sha256").update(token + secret).digest("hex");
}

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await q("INSERT INTO app_session (token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' hours')::interval)", [tokenHash(token), userId, String(TTL_HOURS)]);
  return token;
}

export async function verifyLogin(email: string, password: string): Promise<User | null> {
  const rows = await q<User & { password_hash: string; disabled: boolean }>(
    "SELECT id, email, display_name, role, password_hash, disabled FROM app_user WHERE lower(email)=lower($1)", [email]);
  const u = rows[0];
  // Compare against a dummy hash when the user is unknown, so timing does not reveal valid emails.
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || u.disabled || !ok) return null;
  return { id: u.id, email: u.email, display_name: u.display_name, role: u.role };
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const rows = await q<User>(
    `SELECT u.id, u.email, u.display_name, u.role FROM app_session s JOIN app_user u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, [tokenHash(token)]);
  return rows[0] ?? null;
}

export async function requireUser(allowed?: Role[]): Promise<User> {
  const u = await currentUser();
  if (!u) redirect("/login");
  if (allowed && !allowed.includes(u.role)) redirect("/?denied=1");
  return u;
}

export async function audit(userId: number | null, action: string, target?: string, detail?: unknown) {
  await q("INSERT INTO audit_log (user_id, action, target, detail) VALUES ($1,$2,$3,$4)", [userId, action, target ?? null, detail ? JSON.stringify(detail) : null]);
}

export async function destroySession(token: string | undefined) {
  if (token) await q("DELETE FROM app_session WHERE token_hash=$1", [tokenHash(token)]);
}
