import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type PhoenixCloudSignInAttempt } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  phoenixCloudBeginSignIn,
  phoenixCloudCancelSignIn,
  phoenixCloudCompleteSignIn,
  phoenixCloudSignOut,
  phoenixCloudStatus,
} from "../../state/phoenixCloud";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function PhoenixCloudSettings({
  environmentId,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
}) {
  const allowed = useAtomValue(phoenixCloudBeginSignIn.permissionAtom(environmentId));
  const status = useEnvironmentQuery(
    allowed ? phoenixCloudStatus({ environmentId, input: {} }) : null,
  );
  const begin = useAtomCommand(phoenixCloudBeginSignIn);
  const complete = useAtomCommand(phoenixCloudCompleteSignIn);
  const cancel = useAtomCommand(phoenixCloudCancelSignIn);
  const signOut = useAtomCommand(phoenixCloudSignOut);
  const [cloudUrl, setCloudUrl] = useState("");
  const [name, setName] = useState(environmentLabel);
  const [attempt, setAttempt] = useState<PhoenixCloudSignInAttempt | null>(null);
  const [pending, setPending] = useState(false);
  const activeAttempt = useRef<string | null>(null);
  const unmounted = useRef(false);
  const cancelOnUnmount = useEffectEvent((attemptId: string) => {
    void cancel({ environmentId, input: { attemptId } });
  });
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (activeAttempt.current) cancelOnUnmount(activeAttempt.current);
    };
    // The parent keys this component by environment, so cleanup uses its original destination.
  }, []);

  const login = async () => {
    setPending(true);
    const result = await begin({
      environmentId,
      input: { name: name.trim(), ...(cloudUrl.trim() ? { cloudUrl: cloudUrl.trim() } : {}) },
    });
    if (result._tag !== "Success") {
      if (!unmounted.current) setPending(false);
      return;
    }
    if (unmounted.current) {
      await cancel({ environmentId, input: { attemptId: result.value.attemptId } });
      return;
    }
    const value = result.value;
    activeAttempt.current = value.attemptId;
    setAttempt(value);
    void ensureLocalApi()
      .shell.openExternal(value.verificationUriComplete ?? value.verificationUri)
      .catch(() => undefined);
    await complete({ environmentId, input: { attemptId: value.attemptId } });
    if (unmounted.current || activeAttempt.current !== value.attemptId) return;
    activeAttempt.current = null;
    setAttempt(null);
    setPending(false);
    status.refresh();
  };
  const signedIn = status.data?.state === "signed-in" ? status.data : null;
  return (
    <SettingsSection title={`Phoenix Cloud · ${environmentLabel}`}>
      <SettingsRow
        title="Account status"
        description={
          status.error ??
          (signedIn ? "Signed in to Phoenix Cloud." : "Not signed in to Phoenix Cloud.")
        }
      >
        <Button
          variant="outline"
          disabled={!allowed || pending || status.isPending}
          onClick={status.refresh}
        >
          Refresh
        </Button>
      </SettingsRow>
      {signedIn ? (
        <SettingsRow
          title={signedIn.account.email}
          description={`${signedIn.installation.name} · ${signedIn.installation.kind} · ${signedIn.cloudUrl}`}
        >
          <Button
            variant="outline"
            disabled={!allowed || pending}
            onClick={async () => {
              setPending(true);
              await signOut({ environmentId, input: {} });
              if (!unmounted.current) {
                setPending(false);
                status.refresh();
              }
            }}
          >
            Sign out
          </Button>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow
            title="Cloud URL"
            description="Use the HTTPS address of your Phoenix Cloud website, or leave blank to use the server configuration."
          >
            <Input
              aria-label="Phoenix Cloud URL"
              value={cloudUrl}
              onChange={(event) => setCloudUrl(event.target.value)}
              disabled={pending || !allowed}
              placeholder="https://your-cloud-host"
            />
          </SettingsRow>
          <SettingsRow
            title="Installation name"
            description={`The installation runs on ${environmentLabel}.`}
          >
            <Input
              aria-label="Phoenix Cloud installation name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              disabled={pending || !allowed}
            />
          </SettingsRow>
          <SettingsRow
            title={attempt ? `Confirm code ${attempt.userCode}` : "Sign in to Phoenix Cloud"}
            description={
              attempt
                ? `Approve this code on the Phoenix Cloud website. Expires ${new Date(attempt.expiresAt).toLocaleTimeString()}.`
                : (status.error ??
                  (allowed
                    ? "Approve this installation in your browser. Signing in does not change who can connect to this environment."
                    : "Managing this account requires access administration permission."))
            }
          >
            {attempt ? (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    void ensureLocalApi().shell.openExternal(
                      attempt.verificationUriComplete ?? attempt.verificationUri,
                    )
                  }
                >
                  Open website
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    const attemptId = activeAttempt.current;
                    activeAttempt.current = null;
                    setAttempt(null);
                    if (attemptId) await cancel({ environmentId, input: { attemptId } });
                    if (!unmounted.current) setPending(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                disabled={!allowed || pending || !name.trim() || status.isPending || !!status.error}
                onClick={() => void login()}
              >
                {pending ? "Starting…" : "Sign in"}
              </Button>
            )}
          </SettingsRow>
        </>
      )}
    </SettingsSection>
  );
}
