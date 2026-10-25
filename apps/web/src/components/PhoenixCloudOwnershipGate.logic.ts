export function resolvePhoenixCloudOwnershipView({
  state,
  error,
  locallySignedOut,
}: {
  state: string | undefined;
  error: string | null;
  locallySignedOut: boolean;
}): "app" | "link" | "loading" | "unavailable" {
  if (locallySignedOut) return "link";
  if (error) return "unavailable";
  switch (state) {
    case "signed-in":
      return "app";
    case "signed-out":
      return "link";
    case undefined:
      return "loading";
    default:
      return "unavailable";
  }
}
