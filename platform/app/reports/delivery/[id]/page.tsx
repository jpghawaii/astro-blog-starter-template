import { notFound } from "next/navigation";
import { CAN, requireUser } from "@/lib/auth";
import { campaign } from "@/lib/campaign";
import { nowHst, resolveAudience } from "@/lib/reporting";
import { CampaignBody } from "@/components/CampaignBody";
import { ModeSwitch, ReportFooter } from "@/components/ReportParts";

export default async function DeliveryReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ audience?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const audience = resolveAudience(user, (await searchParams).audience);
  const d = await campaign(id);
  if (!d) notFound();
  const sources = audience === "client" ? d.sourceIds.filter((s) => d.allowed.includes("client_report") || s === "jpg_master_inventory") : d.sourceIds;
  return (
    <>
      <ModeSwitch audience={audience} canInternal={CAN.viewRestrictedSources(user.role)} base={`/reports/delivery/${id}`} />
      <article className="report">
        <div className="small muted">JPG MEDIA · DELIVERY &amp; OUTCOME REPORT</div>
        <h1>{d.c.name}</h1>
        <p>Prepared for {d.c.advertiser}</p>
        <CampaignBody d={d} showRevenue={CAN.viewRevenue(user.role)} clientView={audience === "client"} />
        <h2>Limitations</h2>
        <ul className="small">
          <li>Observed events are counted per reporting system; they are only totalled across systems where a shared order or coupon key allows deduplication.</li>
          <li>Attributed results credit tagged actions to the campaign; they do not by themselves show the campaign caused those actions.</li>
          <li>Incremental lift is reported only for campaigns run with a declared control group.</li>
        </ul>
        <ReportFooter sourceIds={[...sources, "jpg_master_inventory", "jpg_model", "jpg_assumptions"]} audience={audience} generated={nowHst()} hasDemo={d.c.is_demo}
          excluded={audience === "internal" && !d.allowed.includes("client_report") ? ["Exposure estimates (one or more sources not cleared for client reports)"] : []} />
      </article>
    </>
  );
}
