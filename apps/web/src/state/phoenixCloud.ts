import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const phoenixCloudStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:phoenix-cloud:status",
  tag: WS_METHODS.phoenixCloudStatus,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});
export const phoenixCloudBeginBrowserSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "phoenix-cloud:begin-browser-sign-in",
  tag: WS_METHODS.phoenixCloudBeginBrowserSignIn,
});
export const phoenixCloudCompleteBrowserSignIn = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "phoenix-cloud:complete-browser-sign-in",
    tag: WS_METHODS.phoenixCloudCompleteBrowserSignIn,
  },
);
export const phoenixCloudSignOut = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "phoenix-cloud:sign-out",
  tag: WS_METHODS.phoenixCloudSignOut,
});

export const phoenixCloudRefreshStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "phoenix-cloud:refresh-status",
  tag: WS_METHODS.phoenixCloudStatus,
});
