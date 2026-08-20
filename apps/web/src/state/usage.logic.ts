/** Selects the Environment-scoped historical view without affecting Capacity inputs. */
export function selectHistoricalUsageEnvironments<
  TEnvironment extends { readonly environmentId: string },
>(environments: readonly TEnvironment[], environmentId: string | null): readonly TEnvironment[] {
  if (environmentId === null) return environments;
  return environments.filter((environment) => environment.environmentId === environmentId);
}
