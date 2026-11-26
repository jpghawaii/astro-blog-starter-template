"use client";
import dynamic from "next/dynamic";
import type { MapVenue } from "./VenueMap";
const VenueMap = dynamic(() => import("./VenueMap"), { ssr: false, loading: () => <div className="map card">Loading map…</div> });
export default function MapClient({ venues }: { venues: MapVenue[] }) { return <VenueMap venues={venues} />; }
