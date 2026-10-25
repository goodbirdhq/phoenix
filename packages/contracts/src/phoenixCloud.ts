import * as Schema from "effect/Schema";

export const PhoenixCloudInstallation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["desktop", "remote-server"]),
});

export const PhoenixCloudAccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("signed-out") }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
  Schema.Struct({
    state: Schema.Literal("signed-in"),
    cloudUrl: Schema.String,
    account: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
    installation: PhoenixCloudInstallation,
    scopes: Schema.Array(Schema.String),
    expiresAt: Schema.String,
  }),
]);
export type PhoenixCloudAccountStatus = typeof PhoenixCloudAccountStatus.Type;

export const PhoenixCloudSignInInput = Schema.Struct({
  cloudUrl: Schema.optionalKey(Schema.String),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
});
export type PhoenixCloudSignInInput = typeof PhoenixCloudSignInInput.Type;

export const PhoenixCloudSignInAttempt = Schema.Struct({
  attemptId: Schema.String,
  verificationUri: Schema.String,
  verificationUriComplete: Schema.optionalKey(Schema.String),
  userCode: Schema.String,
  expiresAt: Schema.String,
  intervalSeconds: Schema.Number,
});
export type PhoenixCloudSignInAttempt = typeof PhoenixCloudSignInAttempt.Type;

export const PhoenixCloudAttemptInput = Schema.Struct({ attemptId: Schema.String });

export class PhoenixCloudAccountError extends Schema.TaggedError<PhoenixCloudAccountError>()(
  "PhoenixCloudAccountError",
  {
    reason: Schema.Literals([
      "configuration",
      "installation-name",
      "network",
      "protocol",
      "storage",
      "cancelled",
      "expired",
      "denied",
      "busy",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "installation-name":
        return "Installation name must contain between 1 and 80 characters.";
      case "configuration":
        return "Configure a valid HTTPS Phoenix Cloud URL before signing in.";
      case "network":
        return "Could not reach Phoenix Cloud. Try again.";
      case "protocol":
        return "Phoenix Cloud returned an unexpected response.";
      case "storage":
        return "Could not read or save the Phoenix Cloud credential.";
      case "cancelled":
        return "Phoenix Cloud sign-in was cancelled.";
      case "expired":
        return "Phoenix Cloud sign-in expired. Start again.";
      case "denied":
        return "Phoenix Cloud sign-in was denied.";
      case "busy":
        return "Phoenix Cloud sign-in is already in progress.";
    }
  }
}
