import type { Db } from "../db/client.js";

export interface OpsHttpServer {
  close: () => Promise<void>;
}

/**
 * Start the ops hub HTTP surface (run-result callback, health, manual
 * trigger). Implemented by the runner wave; the signature is frozen so the
 * worker CLI can wire it now.
 */
export async function startHttpServer(_deps: { db: Db }): Promise<OpsHttpServer> {
  throw new Error("startHttpServer is not implemented yet (runner wave)");
}
