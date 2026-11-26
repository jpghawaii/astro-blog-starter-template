"use client";
import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";

export interface MapVenue { id: string; name: string; lat: number; lon: number; island: string | null; formats: string[]; assets: number; quality: string; demo: boolean }

const COLORS: Record<string, string> = {
  cstore_screen: "#0b6e69", pump_top: "#c2410c", checkout: "#7c3aed", hotel_screen: "#1d4ed8", mall_static: "#b91c1c", mall_screen: "#0e7490", vehicle: "#4d7c0f",
};

export default function VenueMap({ venues }: { venues: MapVenue[] }) {
  return (
    <MapContainer center={[20.6, -157.4]} zoom={7} className="map" scrollWheelZoom>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {venues.map((v) => (
        <CircleMarker key={v.id} center={[v.lat, v.lon]} radius={5 + Math.min(8, Math.sqrt(v.assets) * 2)}
          pathOptions={{ color: v.quality === "geocoded_address" ? "#555" : "#fff", weight: v.quality === "geocoded_address" ? 2 : 1, dashArray: v.quality === "geocoded_address" ? "3" : undefined, fillColor: COLORS[v.formats[0]] ?? "#333", fillOpacity: 0.85 }}>
          <Popup>
            <b>{v.name}</b>{v.demo && " (DEMO)"}<br />{v.island ?? "island unknown"} · {v.assets} asset(s)<br />{v.formats.join(", ")}<br />
            <span style={{ fontSize: 11 }}>location: {v.quality.replace(/_/g, " ")}</span><br />
            <a href={`/venues/${v.id}`}>Open profile →</a>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}

export const FORMAT_COLORS = COLORS;
