import { useAtomValue } from "@effect/atom-react";
import {
  salesEngineKey,
  thisDeviceState,
  type SalesDeviceKey,
  type SalesDeviceKeyStore,
} from "@t3tools/client-runtime/sales/devices";
import { salesFailureText, type SalesFailureText } from "@t3tools/client-runtime/sales/outreach";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canActOnSales,
  createSalesEnvironmentAtoms,
  isSalesConfigured,
} from "@t3tools/client-runtime/state/sales";
import { type EnvironmentId, SalesActionError, type SalesDevice } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { type EnvironmentPresentation, useEnvironments } from "./environments";
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

const isSalesActionError = Schema.is(SalesActionError);

export interface SalesFailure extends SalesFailureText {
  /** The card's version now, when the engine said it moved on. */
  readonly currentHash: string | null;
}

/** A failed sales command as the person should read it. */
export function readSalesFailure(result: AtomCommandResult<unknown, unknown>): SalesFailure | null {
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  if (isSalesActionError(error)) {
    return { ...salesFailureText(error.reason, error.message), currentHash: error.currentHash };
  }
  return {
    title: "Something went wrong",
    description: error instanceof Error ? error.message : "The request did not complete.",
    reread: false,
    currentHash: null,
  };
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

/**
 * Why this client may not enrol a device for this environment, or null when it may. A device
 * key is only as safe as the code that holds it: a client served by, or running on, the machine
 * whose server holds the action token is code the agents on that machine can change. So a
 * local connection (the web UI that server serves, or the desktop app's own backend) never
 * enrols. This cannot see a remote connection to the same machine; the docs say so.
 */
export function salesEnrolmentBlockedReason(
  environment: Pick<EnvironmentPresentation, "entry">,
): string | null {
  const target = environment.entry.target;
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target)
    ? "This client runs on, or is served by, the machine that runs the sales agents, so an agent there could use a key enrolled here. Enrol from the desktop app on another computer, or from the hosted web app."
    : null;
}

/**
 * This device's key for the environment's engine and the engine's device list. Rereads the
 * list when the window regains focus, since a device turns active by a press in Slack.
 */
export function useSalesDevice(environmentId: EnvironmentId, baseUrl: string, canAct: boolean) {
  const engine = salesEngineKey(baseUrl);
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
    reload,
  };
}
