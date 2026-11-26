import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE, destroySession } from "@/lib/auth";

export async function POST(req: Request) {
  const jar = await cookies();
  await destroySession(jar.get(COOKIE)?.value);
  jar.delete(COOKIE);
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
