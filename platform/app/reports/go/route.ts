import { NextResponse } from "next/server";
export function GET(req: Request) {
  const u = new URL(req.url);
  const kind = u.searchParams.get("kind") === "audience" ? "audience" : "media-sheet";
  const id = (u.searchParams.get("venue") ?? "").replace(/\D/g, "");
  return NextResponse.redirect(new URL(`/reports/${kind}/${id}`, req.url));
}
