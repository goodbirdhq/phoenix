import type { EnvironmentPresentation } from "../../state/environments";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isLoopbackHostname } from "../../environments/primary";

export function environmentConnectionKind(environment: EnvironmentPresentation) {
  const target = environment.entry.target;
  if (isDesktopLocalConnectionTarget(target)) return "Local";
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      try {
        return isLoopbackHostname(new URL(target.httpBaseUrl).hostname) ? "Local" : "Remote link";
      } catch {
        return "Remote link";
      }
    case "SshConnectionTarget":
      return "SSH";
    case "RelayConnectionTarget":
      return "Legacy managed connection";
    default:
      return "Remote link";
  }
}
