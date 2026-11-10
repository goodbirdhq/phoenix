import { useAtomValue } from "@effect/atom-react";
import {
  thisDeviceState,
  type SalesDeviceKey,
  type SalesDeviceKeyStore,
  type SigningDevice,
} from "@t3tools/client-runtime/sales/devices";
import { signApproval, type VerifiedVersion } from "@t3tools/client-runtime/sales/signing";
import { approveVersions } from "@t3tools/client-runtime/sales/approve";
import {
  salesDeviceBlockedReason,
  type SalesGuardEnvironment,
  type SalesKeyPlatform,
} from "@t3tools/client-runtime/sales/device-guard";
import { readSalesFailure } from "@t3tools/client-runtime/sales/failure";
import { dispatchedThreads } from "@t3tools/client-runtime/sales/outreach";
import {
  canActOnSales,
  createSalesEnvironmentAtoms,
  isSalesConfigured,
  salesViewOf,
} from "@t3tools/client-runtime/state/sales";
import {
  type EnvironmentId,
  type SalesDevice,
  type SalesDispatchSource,
  type SalesViewName,
  salesDispatchThreadPrefix,
  salesEngineKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { isElectron } from "../env";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { isHostedStaticApp } from "../hostedPairing";
import {
  type EnvironmentPresentation,
  useEnvironmentConnected,
  useEnvironments,
} from "./environments";
import { useEnvironmentThreadTitles } from "./entities";
import { useAtomCommand } from "./use-atom-command";

export const salesEnvironment = createSalesEnvironmentAtoms(connectionAtomRuntime);

/** Environments whose settings name a sales engine; the Sales area shows only for these. */
export function useSalesEnvironments() {
  const { isReady, environments } = useEnvironments();
  const configured = useMemo(
    () => environments.filter((environment) => isSalesConfigured(environment.serverConfig)),
    [environments],
  );
  return { isReady, environments: configured };
}

/**
 * The Sales environment a page shows: the one named in the URL when it is configured, else the
 * first configured one. Null while none is.
 */
export function useSalesTarget(requested: string | undefined) {
  const { isReady, environments } = useSalesEnvironments();
  const target =
    environments.find((environment) => environment.environmentId === requested) ??
    environments[0] ??
    null;
  return { isReady, environments, target, canAct: canActOnSales(target?.serverConfig) };
}

/** Subscribes the environment's Sales stream while mounted; the server polls only then. */
export function useSalesState(environmentId: EnvironmentId) {
  return useAtomValue(salesEnvironment.stateValueAtom(environmentId));
}

/**
 * One area's engine list, subscribed while mounted; the server reads it only while some client
 * is. `failed` means the stream itself failed (an older server, say), not the engine.
 */
export function useSalesView<View extends SalesViewName>(environmentId: EnvironmentId, view: View) {
  const result = useAtomValue(salesEnvironment.view({ environmentId, input: { view } }));
  return {
    read: salesViewOf(Option.getOrNull(AsyncResult.value(result)), view),
    failed: AsyncResult.isFailure(result),
  };
}

/**
 * The threads dispatched from cards or conversations, from the environment's read model.
 * `sources` keys the memo, so callers pass a stable (memoized) array.
 */
export function useDispatchedThreads(
  environmentId: EnvironmentId,
  sources: ReadonlyArray<SalesDispatchSource>,
) {
  const titles = useEnvironmentThreadTitles(environmentId);
  return useMemo(
    () => dispatchedThreads(titles, sources.map(salesDispatchThreadPrefix)),
    [titles, sources],
  );
}

// --- Device keys ------------------------------------------------------------------------------

const DB_NAME = "phoenix-sales";
const STORE = "device-keys";

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(STORE, { keyPath: "engine" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open device key storage.")),
    );
  });
}

async function withStore<A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<A> {
  const db = await openKeyDatabase();
  try {
    return await new Promise<A>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.addEventListener("complete", () => resolve(request.result as A));
      transaction.addEventListener("error", () =>
        reject(transaction.error ?? new Error("Device key storage failed.")),
      );
    });
  } finally {
    db.close();
  }
}

/**
 * Device keys in this origin's IndexedDB. A non-extractable CryptoKey is stored as itself
 * (structured clone), so it can sign after a reload but its bytes can never be read, by this
 * code or any other. Web and desktop each have their own origin, so each is its own device.
 */
export const salesDeviceKeyStore: SalesDeviceKeyStore = {
  load: async (engine) =>
    (await withStore<SalesDeviceKey | undefined>("readonly", (store) => store.get(engine))) ?? null,
  save: (key) => withStore("readwrite", (store) => store.put(key)),
  remove: (engine) => withStore("readwrite", (store) => store.delete(engine)),
};

function guardEnvironments(
  environments: ReadonlyArray<EnvironmentPresentation>,
): ReadonlyArray<SalesGuardEnvironment> {
  return environments.map((environment) => ({
    target: environment.entry.target,
    // An enabled environment whose settings have not arrived might hold the engine; a disabled
    // one is not connected, so it is judged by what it last reported, if anything.
    salesBaseUrl:
      environment.serverConfig?.settings.salesEngine.baseUrl ??
      (environment.entry.enabled ? null : ""),
  }));
}

function keyPlatform(): SalesKeyPlatform {
  return isElectron
    ? { kind: "desktop", isLocalSecondary: isDesktopLocalConnectionTarget }
    : { kind: "web", servedByPhoenixServer: !isHostedStaticApp() };
}

/**
 * Whether this client may enrol or sign with a device key (`salesDeviceBlockedReason`). The
 * returned check reads the client's environments as they are at the call, so signing checks
 * again right before it signs, not only when the page rendered.
 */
export function useSalesDeviceGuard(): () => string | null {
  const { environments } = useEnvironments();
  const latest = useRef(environments);
  useEffect(() => {
    latest.current = environments;
  });
  return useCallback(
    () => salesDeviceBlockedReason(keyPlatform(), guardEnvironments(latest.current)),
    [],
  );
}

/**
 * Signs verified versions with this device's key and sends them (`approveVersions`). The device
 * is the one at the press; the device guard is read again before each batch.
 */
export function useApproveVersions(environmentId: EnvironmentId) {
  const approve = useAtomCommand(salesEnvironment.approve, { reportFailure: false });
  const refresh = useAtomCommand(salesEnvironment.refresh, { reportFailure: false });
  const blockedReason = useSalesDeviceGuard();
  return (device: SigningDevice, versions: ReadonlyArray<VerifiedVersion>) =>
    approveVersions({
      versions,
      approve: (items) => approve({ environmentId, input: { items } }),
      refresh: () => refresh({ environmentId, input: {} }),
      device: () => ({ ...device, blocked: blockedReason() }),
      sign: (key, version) =>
        signApproval({ privateKey: key.privateKey, deviceId: key.deviceId, version }),
    });
}

/**
 * This device's key for the environment's engine and the engine's device list, read once
 * connected. Rereads the list on reconnect and when the window regains focus, since a device
 * turns active by a press in Slack.
 */
export function useSalesDevice(environmentId: EnvironmentId, baseUrl: string, canAct: boolean) {
  const engine = salesEngineKey(baseUrl);
  const { environments } = useEnvironments();
  const blocked = salesDeviceBlockedReason(keyPlatform(), guardEnvironments(environments));
  const listDevices = useAtomCommand(salesEnvironment.listDevices, { reportFailure: false });
  const [key, setKey] = useState<SalesDeviceKey | null | undefined>(undefined);
  const [devices, setDevices] = useState<ReadonlyArray<SalesDevice> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = useEnvironmentConnected(environmentId);

  const reload = useCallback(async () => {
    setKey(await salesDeviceKeyStore.load(engine).catch(() => null));
    if (!canAct || !connected) return;
    const result = await listDevices({ environmentId, input: {} });
    if (result._tag === "Success") {
      setDevices(result.value.items);
      setError(null);
    } else {
      setError(readSalesFailure(result).description);
    }
  }, [canAct, connected, engine, environmentId, listDevices]);

  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  return {
    engine,
    key: key ?? null,
    loaded: key !== undefined,
    devices,
    error,
    state: thisDeviceState(key ?? null, canAct ? devices : null),
    /** Set when this client must not enrol or sign; see `salesDeviceBlockedReason`. */
    blocked,
    reload,
  };
}
