import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";

/** What the guard needs to know about one environment this client connects to. */
export interface SalesGuardEnvironment {
  readonly target: ConnectionTarget;
  /** The environment's Sales engine URL; null while its settings are not loaded. */
  readonly salesBaseUrl: string | null;
}

/**
 * Why this client may not enrol or sign with a device key for `engine`, or null when it may.
 * A key is only as safe as the code that holds it, so it must live in a client whose code no
 * Phoenix server (the agents' machine) serves or can change:
 *
 * - On web, only the hosted web app may hold keys. Any other origin is a `phoenix` server's, and
 *   any `PrimaryConnectionTarget` is a second sign of one, whichever environment reads the engine.
 * - On desktop the code ships with the app, but its local backends (the primary and `local:`
 *   ones) run on this machine. If one of them has any sales engine configured, agents that act
 *   for an engine run here and could change the app, so it is refused. URLs are not compared,
 *   since one engine can answer at several. A local backend whose settings are not loaded yet
 *   counts as configured.
 *
 * Keys are per engine, so this looks across every environment rather than at the one on screen.
 * It cannot see a remote connection that reaches this same machine; the docs say so.
 */
export function salesDeviceBlockedReason(input: {
  readonly isDesktop: boolean;
  /**
   * On web, whether this page came from anywhere but the hosted web app. Checked on its own so
   * the answer does not wait for the primary environment to register.
   */
  readonly servedByPhoenixServer: boolean;
  readonly engine: string;
  readonly environments: ReadonlyArray<SalesGuardEnvironment>;
}): string | null {
  if (!input.isDesktop) {
    return input.servedByPhoenixServer ||
      input.environments.some(
        (environment) => environment.target._tag === "PrimaryConnectionTarget",
      )
      ? "This page is served by a Phoenix server, which runs agents that could change it and use a key enrolled here. Enrol and approve from the hosted web app or the desktop app on another computer."
      : null;
  }
  const local = input.environments.filter(
    (environment) =>
      environment.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.target),
  );
  // Any engine at all, not just this one: the same engine can sit behind another URL.
  return local.some(
    (environment) =>
      environment.salesBaseUrl === null || environment.salesBaseUrl.trim().length > 0,
  )
    ? "This desktop app's own backend has a sales engine configured, so agents that act for it run on this computer and could use a key enrolled here. Enrol and approve from the desktop app on another computer, or from the hosted web app."
    : null;
}
