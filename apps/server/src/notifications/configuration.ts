import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

/** Explicit input to the retained sender; no runtime layer installs delivery credentials. */
export class FcmConfiguration extends Context.Service<
  FcmConfiguration,
  {
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
  }
>()("t3/notifications/configuration/FcmConfiguration") {}
