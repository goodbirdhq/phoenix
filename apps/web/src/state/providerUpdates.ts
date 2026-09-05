import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

/** Observes existing provider projections; never starts an update check. */
const providerUpdateCount = Atom.make((get) => {
  let count = 0;
  for (const environmentId of get(environmentPresentations.presentationsAtom).keys()) {
    for (const provider of get(serverEnvironment.providersValueAtom(environmentId)) ?? []) {
      if (provider.versionAdvisory?.status === "behind_latest") count++;
    }
  }
  return count;
});

export function useProviderUpdateCount() {
  return useAtomValue(providerUpdateCount);
}
