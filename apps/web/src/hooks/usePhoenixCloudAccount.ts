import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { reconcilePhoenixCloudLogout } from "./phoenixCloudLogout";
import { useLocation, useRouter } from "@tanstack/react-router";
import { isElectron } from "../env";
import {
  PHOENIX_CLOUD_CALLBACK_PATH,
  readPhoenixCloudCallback,
  savePhoenixCloudBrowserAttempt,
} from "../phoenixCloudBrowserAuth";
import {
  phoenixCloudBeginBrowserSignIn,
  phoenixCloudCompleteBrowserSignIn,
  phoenixCloudSignOut,
  phoenixCloudRefreshStatus,
  phoenixCloudStatus,
} from "../state/phoenixCloud";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

// Suppress stale signed-in data until the server acknowledges persisted local logout.
const localLogout = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make({ signedOut: false, pending: false, error: null as string | null }).pipe(
    Atom.keepAlive,
  ),
);

export function usePhoenixCloudAccount(environmentId: EnvironmentId) {
  const allowed = useAtomValue(phoenixCloudBeginBrowserSignIn.permissionAtom(environmentId));
  const status = useEnvironmentQuery(phoenixCloudStatus({ environmentId, input: {} }));
  const local = useAtomValue(localLogout(environmentId));
  const setLocal = useAtomSet(localLogout(environmentId));
  const confirmed = status.isSuccess && !status.isPending;
  const ownershipState = status.data?.state;
  useEffect(() => {
    const reconciled = reconcilePhoenixCloudLogout(local, { state: ownershipState, confirmed });
    if (reconciled !== local) setLocal(reconciled);
  }, [local, ownershipState, confirmed, setLocal]);
  const setSignedOut = (signedOut: boolean) => setLocal({ signedOut, pending: false, error: null });
  const signOut = useAtomCommand(phoenixCloudSignOut);
  const refreshStatus = useAtomCommand(phoenixCloudRefreshStatus);
  const [verifying, setVerifying] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const verify = async () => {
    if (verifying) return;
    setVerifying(true);
    setVerificationError(null);
    const result = await refreshStatus({ environmentId, input: { refresh: true } });
    status.refresh();
    if (!mounted.current) return;
    setVerifying(false);
    if (result._tag === "Failure") setVerificationError(formatEnvironmentQueryError(result.cause));
  };
  const logout = async () => {
    if (!allowed || local.pending) return;
    setLocal({ signedOut: true, pending: true, error: null });
    const result = await signOut({ environmentId, input: {} });
    setLocal({
      signedOut: true,
      pending: false,
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    });
    status.refresh();
  };
  return {
    allowed,
    status,
    verify,
    verifying,
    verificationError,
    signedOut: local.signedOut,
    setSignedOut,
    logout,
    loggingOut: local.pending,
    logoutError: local.error,
  };
}

// The destination is captured before leaving the app, independently of the active environment.
export function usePhoenixCloudSignIn(environmentId: EnvironmentId) {
  const account = usePhoenixCloudAccount(environmentId);
  const begin = useAtomCommand(phoenixCloudBeginBrowserSignIn);
  const complete = useAtomCommand(phoenixCloudCompleteBrowserSignIn);
  const route = useLocation({ select: (location) => location.href });
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ expiresAt: string } | null>(null);
  const activeReturnUrl = useRef<string | null>(null);
  const generation = useRef(0);

  const cancelSignIn = async () => {
    generation.current++;
    const returnUrl = activeReturnUrl.current;
    activeReturnUrl.current = null;
    if (returnUrl) await window.desktopBridge?.cancelPhoenixCloudCallback?.(returnUrl);
    setAttempt(null);
    setPending(false);
  };
  const login = async (input: { name: string; cloudUrl: string }) => {
    if (!account.allowed || pending) return;
    const current = ++generation.current;
    setPending(true);
    setError(null);
    let returnUrl: string | null = null;
    try {
      if (
        isElectron &&
        (!window.desktopBridge?.preparePhoenixCloudCallback ||
          !window.desktopBridge.receivePhoenixCloudCallback)
      ) {
        throw new Error("Update the desktop app to link your Phoenix Cloud account.");
      }
      returnUrl = isElectron
        ? await window.desktopBridge!.preparePhoenixCloudCallback!()
        : `${window.location.origin}${PHOENIX_CLOUD_CALLBACK_PATH}`;
      if (current !== generation.current) return;
      activeReturnUrl.current = returnUrl;
      const result = await begin({
        environmentId,
        input: {
          name: input.name.trim(),
          ...(input.cloudUrl.trim() ? { cloudUrl: input.cloudUrl.trim() } : {}),
          returnUrl,
        },
      });
      if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
      if (current !== generation.current) return;
      if (!isElectron) {
        savePhoenixCloudBrowserAttempt(window.sessionStorage, result.value.attemptId, {
          environmentId,
          route,
        });
        window.location.assign(result.value.authorizationUrl);
        return;
      }
      setAttempt({ expiresAt: result.value.expiresAt });
      const response = await window.desktopBridge!.receivePhoenixCloudCallback!(
        result.value.authorizationUrl,
      );
      if (current !== generation.current) return;
      const callback = readPhoenixCloudCallback(new URL(response));
      if (
        !callback ||
        callback.state !== result.value.attemptId ||
        callback.returnUrl !== returnUrl
      )
        throw new Error("The sign-in response did not match this attempt. Try again.");
      const completed = await complete({ environmentId, input: callback });
      if (completed._tag === "Failure")
        throw new Error(formatEnvironmentQueryError(completed.cause));
      account.setSignedOut(false);
      account.status.refresh();
      await router.navigate({ href: route, replace: true });
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error ? cause.message : "Could not link Phoenix Cloud. Try again.",
        );
    } finally {
      if (isElectron && returnUrl)
        await window.desktopBridge?.cancelPhoenixCloudCallback?.(returnUrl).catch(() => undefined);
      if (current === generation.current) {
        activeReturnUrl.current = null;
        setAttempt(null);
        setPending(false);
      }
    }
  };
  return { ...account, attempt, pending, error, login, cancelSignIn };
}
