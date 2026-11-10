import { useAtomValue } from "@effect/atom-react";
import {
  thisDeviceState,
  type SalesDeviceKey,
  type SalesDeviceKeyStore,
} from "@t3tools/client-runtime/sales/devices";
import { readSalesFailure } from "@t3tools/client-runtime/sales/failure";
import {
  canActOnSales,
  createSalesEnvironmentAtoms,
  isSalesConfigured,
} from "@t3tools/client-runtime/state/sales";
import { type EnvironmentId, type SalesDevice, salesEngineKey } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { isElectron } from "../env";
import { isHostedStaticApp } from "../hostedPairing";
import { type EnvironmentPresentation, useEnvironments } from "./environments";
import { salesDeviceBlockedReason, type SalesGuardEnvironment } from "./salesDeviceGuard";
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

/**
 * Whether this client may enrol or sign with a key for an engine (`salesDeviceBlockedReason`).
 * The returned check reads the client's environments as they are at the call, so signing checks
 * again right before it signs, not only when the page rendered.
 */
export function useSalesDeviceGuard(): (engine: string) => string | null {
  const { environments } = useEnvironments();
  const latest = useRef(environments);
  useEffect(() => {
    latest.current = environments;
  });
  return useCallback(
    (engine: string) =>
      salesDeviceBlockedReason({
        isDesktop: isElectron,
        servedByPhoenixServer: !isElectron && !isHostedStaticApp(),
        engine,
        environments: guardEnvironments(latest.current),
      }),
    [],
  );
}

/**
 * This device's key for the environment's engine and the engine's device list. Rereads the
 * list when the window regains focus, since a device turns active by a press in Slack.
 */
export function useSalesDevice(environmentId: EnvironmentId, baseUrl: string, canAct: boolean) {
  const engine = salesEngineKey(baseUrl);
  const { environments } = useEnvironments();
  const blocked = salesDeviceBlockedReason({
    isDesktop: isElectron,
    servedByPhoenixServer: !isElectron && !isHostedStaticApp(),
    engine,
    environments: guardEnvironments(environments),
  });
  const listDevices = useAtomCommand(salesEnvironment.listDevices, { reportFailure: false });
  const [key, setKey] = useState<SalesDeviceKey | null | undefined>(undefined);
  const [devices, setDevices] = useState<ReadonlyArray<SalesDevice> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setKey(await salesDeviceKeyStore.load(engine).catch(() => null));
    if (!canAct) return;
    const result = await listDevices({ environmentId, input: {} });
    if (result._tag === "Success") {
      setDevices(result.value.items);
      setError(null);
    } else {
      setError(readSalesFailure(result)?.description ?? null);
    }
  }, [canAct, engine, environmentId, listDevices]);

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
    /** Set when this client must not enrol or sign for this engine; see `salesDeviceGuard`. */
    blocked,
    reload,
  };
}
