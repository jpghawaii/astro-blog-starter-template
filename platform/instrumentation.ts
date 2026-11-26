/**
 * Runs once when the server starts. On a fresh deployment with no users, creates the first admin
 * from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD (12+ chars). Does nothing once any user exists,
 * so these variables can (and should) be removed after first login.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password || !process.env.DATABASE_URL) return;
  if (password.length < 12) {
    console.error("[bootstrap] BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters; no admin created");
    return;
  }
  try {
    const { q } = await import("./lib/db");
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int n FROM app_user");
    if (n > 0) return;
    const bcrypt = (await import("bcryptjs")).default;
    await q("INSERT INTO app_user (email, display_name, password_hash, role) VALUES ($1, 'Administrator', $2, 'admin') ON CONFLICT (email) DO NOTHING",
      [email, await bcrypt.hash(password, 12)]);
    console.log(`[bootstrap] created first admin ${email}`);
  } catch (e) {
    console.error("[bootstrap] could not create admin:", (e as Error).message);
  }
}
