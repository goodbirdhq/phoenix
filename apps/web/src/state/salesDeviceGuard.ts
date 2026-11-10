import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { salesEngineKey } from "@t3tools/client-runtime/sales/devices";

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
 * - On web, any `PrimaryConnectionTarget` means a `phoenix` server served this page, whichever
 *   environment reads the engine. Only the hosted web app, which has no primary, may hold keys.
 * - On desktop the code ships with the app, but its local backends (the primary and `local:`
 *   ones) run on this machine. If one of them holds this engine's settings, the agents that act
 *   for that engine run here and could change the app, so it is refused. A local backend whose
 *   settings are not loaded yet counts as holding it.
 *
 * Keys are per engine, so this looks across every environment rather than at the one on screen.
 * It cannot see a remote connection that reaches this same machine; the docs say so.
 */
export function salesDeviceBlockedReason(input: {
  readonly isDesktop: boolean;
  readonly engine: string;
  readonly environments: ReadonlyArray<SalesGuardEnvironment>;
}): string | null {
  if (!input.isDesktop) {
    return input.environments.some(
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
  return local.some(
    (environment) =>
      environment.salesBaseUrl === null ||
      salesEngineKey(environment.salesBaseUrl) === input.engine,
  )
    ? "This desktop app's own backend reads this sales engine, so its agents run on this computer and could use a key enrolled here. Enrol and approve from the desktop app on another computer, or from the hosted web app."
    : null;
}
