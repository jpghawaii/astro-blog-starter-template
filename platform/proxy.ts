import { NextRequest, NextResponse } from "next/server";

/** Coarse gate: no session cookie -> login. Fine-grained role checks happen server-side per page. */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/_next") || pathname === "/favicon.ico") return NextResponse.next();
  if (!req.cookies.get("jpg_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
