export interface PhoenixCloudLogoutState {
  readonly signedOut: boolean;
  readonly pending: boolean;
  readonly error: string | null;
}

export function reconcilePhoenixCloudLogout(
  local: PhoenixCloudLogoutState,
  status: { readonly state: string | undefined; readonly confirmed: boolean },
): PhoenixCloudLogoutState {
  if (local.pending || !status.confirmed) return local;
  if (local.signedOut && status.state === "signed-out") return { ...local, signedOut: false };
  if (!local.signedOut && local.error && status.state === "signed-in")
    return { ...local, error: null };
  return local;
}
