import { PhoenixCloudAccountStatus, PhoenixCloudSignInInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PhoenixCloudAccount from "../phoenixCloud/PhoenixCloudAccount.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { projectLocationFlags, resolveCliAuthConfig, type CliAuthLocationFlags } from "./config.ts";

const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(PhoenixCloudAccountStatus));

const runWithAccount = Effect.fn("cli.cloud.run")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (account: PhoenixCloudAccount.PhoenixCloudAccount["Service"]) => Effect.Effect<A, E, R>,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  return yield* Effect.gen(function* () {
    return yield* run(yield* PhoenixCloudAccount.PhoenixCloudAccount);
  }).pipe(
    Effect.provide(
      PhoenixCloudAccount.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
      ),
    ),
  );
});

const login = Command.make("login", {
  ...projectLocationFlags,
  cloudUrl: Flag.String("cloud-url").pipe(
    Flag.optional,
    Flag.withDescription("Phoenix Cloud HTTPS origin."),
  ),
  name: Flag.String("name").pipe(
    Flag.withSchema(PhoenixCloudSignInInput.fields.name),
    Flag.withDefault("Remote server"),
    Flag.withDescription("Name shown in Phoenix Cloud."),
  ),
  noBrowser: Flag.Boolean("no-browser").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Sign this server into Phoenix Cloud using a browser on any machine."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const attempt = yield* account.beginSignIn({
          name: flags.name,
          ...(Option.isSome(flags.cloudUrl) ? { cloudUrl: flags.cloudUrl.value } : {}),
        });
        yield* Console.log(
          `Open ${attempt.verificationUriComplete ?? attempt.verificationUri}\nConfirm code: ${attempt.userCode}\nWaiting for approval. Press Ctrl+C to cancel.`,
        );
        const ssh = yield* Config.String("SSH_CONNECTION").pipe(Config.option);
        if (!flags.noBrowser && Option.isNone(ssh)) {
          yield* Effect.gen(function* () {
            const launcher = yield* ExternalLauncher.ExternalLauncher;
            yield* launcher.launchBrowser(
              attempt.verificationUriComplete ?? attempt.verificationUri,
            );
          }).pipe(Effect.provide(ExternalLauncher.layer), Effect.ignore);
        }
        const status = yield* account
          .completeSignIn({ attemptId: attempt.attemptId })
          .pipe(
            Effect.ensuring(
              account.cancelSignIn({ attemptId: attempt.attemptId }).pipe(Effect.ignore),
            ),
          );
        if (status.state === "signed-in")
          yield* Console.log(
            `Signed in as ${status.account.email}. Installation: ${status.installation.name} (${status.installation.kind}).`,
          );
      }),
    ),
  ),
);
const status = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Show this installation's Phoenix Cloud account."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const status = yield* account.status();
        yield* Console.log(
          flags.json
            ? yield* encodeStatus(status)
            : status.state === "signed-in"
              ? `Signed in as ${status.account.email}\n${status.installation.name} (${status.installation.kind})\n${status.cloudUrl}`
              : status.state === "unavailable"
                ? "Phoenix Cloud is unavailable. Saved credentials are retained; retry when the website is reachable."
                : "Not signed in to Phoenix Cloud.",
        );
      }),
    ),
  ),
);
const logout = Command.make("logout", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Revoke this installation's Phoenix Cloud access and remove its credential.",
  ),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      account.signOut().pipe(Effect.andThen(Console.log("Signed out of Phoenix Cloud."))),
    ),
  ),
);

export const phoenixCloudCommand = Command.make("cloud").pipe(
  Command.withDescription("Manage this installation's Phoenix Cloud account."),
  Command.withSubcommands([login, status, logout]),
);
