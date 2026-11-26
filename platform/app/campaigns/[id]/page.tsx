import Link from "next/link";
import { notFound } from "next/navigation";
import { CAN, requireUser } from "@/lib/auth";
import { campaign } from "@/lib/campaign";
import { CampaignBody } from "@/components/CampaignBody";
import { Demo } from "@/components/ui";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const d = await campaign(id);
  if (!d) notFound();
  return (
    <>
      <p className="small"><Link href="/campaigns">← Campaigns</Link></p>
      <h1>{d.c.name} <Demo on={d.c.is_demo} /></h1>
      <p className="sub">{d.c.advertiser} · {d.c.status} · allowed uses of derived figures: {d.allowed.join(", ") || "none"}</p>
      <p><Link className="btn secondary" href={`/reports/proposal/${id}`}>Proposal</Link> <Link className="btn secondary" href={`/reports/delivery/${id}`}>Delivery &amp; outcome report</Link></p>
      <CampaignBody d={d} showRevenue={CAN.viewRevenue(user.role)} clientView={false} />
    </>
  );
}
