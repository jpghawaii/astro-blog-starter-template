import "./globals.css";
import "leaflet/dist/leaflet.css";
import type { Metadata } from "next";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { demoAllowed } from "@/lib/db";

export const metadata: Metadata = { title: "JPG Media Analytics", description: "Hawaii OOH/DOOH inventory, audience measurement and campaign outcomes" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser().catch(() => null);
  return (
    <html lang="en">
      <body>
        {user && (
          <header className="top">
            <Link href="/" className="brand">JPG Media Analytics</Link>
            <nav aria-label="Main">
              <Link href="/">Overview</Link>
              <Link href="/map">Map</Link>
              <Link href="/venues">Venues</Link>
              <Link href="/inventory">Availability</Link>
              <Link href="/advertisers">Advertisers</Link>
              <Link href="/campaigns">Campaigns</Link>
              <Link href="/reports">Reports</Link>
              <Link href="/exceptions">Exceptions</Link>
              <Link href="/sources">Sources</Link>
              <Link href="/methodology">Methodology</Link>
            </nav>
            <span className="who">
              {demoAllowed() && <span className="badge b-demo">DEMO DATA VISIBLE</span>}
              {user.email} · {user.role}
              <form action="/api/auth/logout" method="post"><button className="secondary" type="submit">Sign out</button></form>
            </span>
          </header>
        )}
        <main>{children}</main>
      </body>
    </html>
  );
}
