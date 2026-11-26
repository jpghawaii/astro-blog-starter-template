import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { audit, COOKIE, createSession, verifyLogin } from "@/lib/auth";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = await verifyLogin(email, password);
  if (!user) {
    await new Promise((r) => setTimeout(r, 600));
    redirect("/login?error=1");
  }
  const token = await createSession(user.id);
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 12 * 3600 });
  await audit(user.id, "login");
  redirect("/");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div style={{ maxWidth: 360, margin: "10vh auto" }} className="card">
      <h1>JPG Media Analytics</h1>
      <p className="sub">Sign in. Confidential business data: authorized staff only.</p>
      {error && <p className="notice bad">Email or password not recognized.</p>}
      <form action={login} style={{ display: "grid", gap: 10 }}>
        <label>Email<input name="email" type="email" required autoComplete="username" /></label>
        <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
