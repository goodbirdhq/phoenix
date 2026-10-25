import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PhoenixCloudSignInAttempt } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { reconcilePhoenixCloudLogout } from "./phoenixCloudLogout";
import { ensureLocalApi } from "../localApi";
import {
  phoenixCloudBeginSignIn,
  phoenixCloudCancelSignIn,
  phoenixCloudCompleteSignIn,
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
  const allowed = useAtomValue(phoenixCloudBeginSignIn.permissionAtom(environmentId));
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

// Callers key the component by environment: all in-flight work keeps its original destination.
export function usePhoenixCloudSignIn(environmentId: EnvironmentId) {
  const account = usePhoenixCloudAccount(environmentId);
  const begin = useAtomCommand(phoenixCloudBeginSignIn);
  const complete = useAtomCommand(phoenixCloudCompleteSignIn);
  const cancel = useAtomCommand(phoenixCloudCancelSignIn);
  const [attempt, setAttempt] = useState<PhoenixCloudSignInAttempt | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const activeAttempt = useRef<string | null>(null);
  const cancelOnUnmount = useEffectEvent((attemptId: string) => {
    void cancel({ environmentId, input: { attemptId } });
  });
  useEffect(() => {
    return () => {
      generation.current++;
      const attemptId = activeAttempt.current;
      if (attemptId) cancelOnUnmount(attemptId);
    };
  }, []);

  const cancelSignIn = async () => {
    generation.current++;
    const attemptId = activeAttempt.current;
    activeAttempt.current = null;
    setAttempt(null);
    setPending(false);
    if (attemptId) await cancel({ environmentId, input: { attemptId } });
  };
  const login = async (input: { name: string; cloudUrl: string }) => {
    if (!account.allowed || pending) return;
    const current = ++generation.current;
    setPending(true);
    setError(null);
    const result = await begin({
      environmentId,
      input: {
        name: input.name.trim(),
        ...(input.cloudUrl.trim() ? { cloudUrl: input.cloudUrl.trim() } : {}),
      },
    });
    if (result._tag === "Failure") {
      if (current === generation.current) {
        setError(formatEnvironmentQueryError(result.cause));
        setPending(false);
      }
      return;
    }
    const value = result.value;
    if (current !== generation.current) {
      await cancel({ environmentId, input: { attemptId: value.attemptId } });
      return;
    }
    activeAttempt.current = value.attemptId;
    setAttempt(value);
    void ensureLocalApi()
      .shell.openExternal(value.verificationUriComplete ?? value.verificationUri)
      .catch(() => undefined);
    const completed = await complete({ environmentId, input: { attemptId: value.attemptId } });
    if (current !== generation.current) return;
    activeAttempt.current = null;
    setAttempt(null);
    setPending(false);
    if (completed._tag === "Failure") setError(formatEnvironmentQueryError(completed.cause));
    else account.setSignedOut(false);
    account.status.refresh();
  };
  return { ...account, attempt, pending, error, login, cancelSignIn };
}
