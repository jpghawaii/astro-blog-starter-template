import { CAN, User } from "./auth";
import type { Audience } from "@/components/ReportParts";

export function resolveAudience(user: User, requested: string | undefined): Audience {
  // Only analysts/admins may see the internal version (restricted sources included).
  return requested === "internal" && CAN.viewRestrictedSources(user.role) ? "internal" : "client";
}
export const nowHst = () => new Date().toLocaleString("en-US", { timeZone: "Pacific/Honolulu", dateStyle: "medium", timeStyle: "short" });
export const todayHst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Pacific/Honolulu" });
