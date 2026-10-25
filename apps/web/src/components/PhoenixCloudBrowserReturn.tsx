import { useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";

import { usePhoenixCloudAccount } from "../hooks/usePhoenixCloudAccount";
import {
  clearPhoenixCloudBrowserReturn,
  pendingPhoenixCloudBrowserReturn,
} from "../phoenixCloudBrowserAuth";
import { useEnvironment } from "../state/environments";
import { phoenixCloudCompleteBrowserSignIn } from "../state/phoenixCloud";
import { formatEnvironmentQueryError } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { StandalonePage, StandalonePageHeader } from "./ui/standalone-page";

export function PhoenixCloudBrowserReturn() {
  const [delivery] = useState(pendingPhoenixCloudBrowserReturn);
  if (!delivery) {
    return (
      <ReturnFailure
        message="This sign-in response is missing or expired. Return to Phoenix and try again."
        route="/"
      />
    );
  }
  return <CompleteReturn delivery={delivery} />;
}

function CompleteReturn({
  delivery,
}: {
  delivery: NonNullable<ReturnType<typeof pendingPhoenixCloudBrowserReturn>>;
}) {
  const { attempt, callback } = delivery;
  const account = usePhoenixCloudAccount(attempt.environmentId);
  const environment = useEnvironment(attempt.environmentId);
  const complete = useAtomCommand(phoenixCloudCompleteBrowserSignIn, { reportFailure: false });
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const connected = environment?.connection.phase === "connected";
  useEffect(() => {
    if (!connected || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const result = await complete({ environmentId: attempt.environmentId, input: callback });
        if (result._tag === "Failure") {
          setError(
            callback.error === "access_denied"
              ? "Approval was declined. You can return to Phoenix and try again."
              : formatEnvironmentQueryError(result.cause),
          );
          return;
        }
        account.setSignedOut(false);
        account.status.refresh();
        await router.navigate({ href: attempt.route, replace: true });
      } catch {
        setError("Could not finish linking this installation. Return to Phoenix and try again.");
      } finally {
        clearPhoenixCloudBrowserReturn();
      }
    })();
  }, [connected, complete, attempt, callback, account, router]);
  if (error) return <ReturnFailure message={error} route={attempt.route} />;
  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow="Phoenix Cloud"
        title="Finishing sign-in…"
        description={
          connected
            ? "Linking your installation."
            : "Reconnecting to the installation that started sign-in."
        }
      />
      <p role="status" className="mt-4 text-sm text-muted-foreground">
        Keep this page open until Phoenix returns to your work.
      </p>
      {!connected ? (
        <div className="mt-4">
          <Button variant="outline" render={<Link to="/settings/connections" />}>
            Connections
          </Button>
        </div>
      ) : null}
    </StandalonePage>
  );
}

function ReturnFailure({ message, route }: { message: string; route: string }) {
  const router = useRouter();
  return (
    <StandalonePage tone="error">
      <StandalonePageHeader
        eyebrow="Phoenix Cloud"
        title="Sign-in couldn't finish"
        description={message}
      />
      <div className="mt-5">
        <Button onClick={() => void router.navigate({ href: route, replace: true })}>
          Return to Phoenix
        </Button>
      </div>
    </StandalonePage>
  );
}
