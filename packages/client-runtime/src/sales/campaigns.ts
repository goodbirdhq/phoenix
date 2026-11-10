import type { SalesCampaign } from "@t3tools/contracts";

/** `Email 2`: a step of a sequence, as people count them. */
export const emailStepLabel = (step: number) => `Email ${step}`;

/** The campaign's name; the engine groups sends that carry none under null. */
export const campaignName = (campaign: string | null) => campaign ?? "No campaign";

/** `3 (25%)`: a count, and its share of `of` when there is one to take. */
export const withShare = (count: number, of: number) =>
  of > 0 && count > 0 ? `${count} (${Math.round((count / of) * 100)}%)` : String(count);

/** A campaign's headline figures, shares taken of the people it emailed. */
export const campaignFigures = (campaign: SalesCampaign) => [
  { label: "People", value: String(campaign.contacts) },
  { label: "Replied", value: withShare(campaign.replied, campaign.contacts) },
  { label: "Positive", value: withShare(campaign.positive, campaign.contacts) },
  { label: "Declined", value: String(campaign.declined) },
  { label: "Bounced", value: String(campaign.bounced) },
];
