import { AgentAwarenessPhase } from "@t3tools/contracts/notifications";
import * as Schema from "effect/Schema";

export const ApnsNotificationPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  deepLink: Schema.String,
  // Optional for compatibility with older notification payloads.
  phase: Schema.optional(AgentAwarenessPhase),
  updatedAt: Schema.optional(Schema.String),
});
export type ApnsNotificationPayload = typeof ApnsNotificationPayload.Type;

// Alert copy attached to a Live Activity update/end push. Its presence makes
// the update "alerting": iOS wakes the screen, plays the haptic, and briefly
// expands the Dynamic Island instead of silently redrawing.
export const ApnsLiveActivityAlert = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
});
export type ApnsLiveActivityAlert = typeof ApnsLiveActivityAlert.Type;
