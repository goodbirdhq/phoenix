import type { EnvironmentId, SalesCampaign } from "@t3tools/contracts";

import { useSalesView } from "../../state/sales";
import { SalesViewFrame } from "./SalesViewFrame";

/** `3 (25%)`: a count, and its share of `of` when there is one to take. */
const withShare = (count: number, of: number) =>
  of > 0 && count > 0 ? `${count} (${Math.round((count / of) * 100)}%)` : String(count);

/** People and steps by campaign, from what the engine sent and the replies it read. */
export function SalesCampaigns({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { read, failed } = useSalesView(environmentId, "campaigns");
  return (
    <SalesViewFrame
      title="Campaigns"
      read={read}
      failed={failed}
      description={() => "From the engine's sends and the replies it classified."}
    >
      {(list) =>
        list.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">The engine has sent no cold email yet.</p>
        ) : (
          <div className="space-y-6">
            {list.items.map((campaign) => (
              <CampaignFunnel key={campaign.campaign ?? ""} campaign={campaign} />
            ))}
          </div>
        )
      }
    </SalesViewFrame>
  );
}

const cell = "px-3 py-2 text-right tabular-nums";

function CampaignFunnel({ campaign }: { readonly campaign: SalesCampaign }) {
  const figures = [
    { label: "People", value: String(campaign.contacts) },
    { label: "Replied", value: withShare(campaign.replied, campaign.contacts) },
    { label: "Positive", value: withShare(campaign.positive, campaign.contacts) },
    { label: "Declined", value: String(campaign.declined) },
    { label: "Bounced", value: String(campaign.bounced) },
  ];
  return (
    <section aria-label={campaign.campaign ?? "No campaign"} className="rounded-lg border">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-4 py-3">
        <h2 className="min-w-40 flex-1 text-sm font-medium">
          {campaign.campaign ?? "No campaign"}
        </h2>
        <dl className="flex flex-wrap gap-5">
          {figures.map((figure) => (
            <div key={figure.label} className="flex flex-col">
              <dt className="text-xs text-muted-foreground">{figure.label}</dt>
              <dd className="text-sm tabular-nums">{figure.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {campaign.steps.length > 0 ? (
        <table className="w-full border-t text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-normal">Step</th>
              <th className={`${cell} font-normal`}>Sent</th>
              <th className={`${cell} font-normal`}>Replied</th>
              <th className={`${cell} font-normal`}>Positive</th>
              <th className={`${cell} pr-4 font-normal`}>Bounced</th>
            </tr>
          </thead>
          <tbody>
            {campaign.steps.map((step) => (
              <tr key={step.step} className="border-t">
                <td className="px-4 py-2">Email {step.step}</td>
                <td className={cell}>{step.sent}</td>
                <td className={cell}>{withShare(step.replied, step.sent)}</td>
                <td className={cell}>{step.positive}</td>
                <td className={`${cell} pr-4`}>{step.bounced}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
