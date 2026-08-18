// Baked in at pack time by apps/server/vite.config.ts. Absent entirely when the
// CLI runs straight from source, and an empty string when the build happened
// somewhere git could not answer (a published tarball, a checkout with no
// .git). The three cases are kept distinct so `--version` can be honest about
// which one it is rather than guessing a commit.
declare const __T3CODE_BUILD_COMMIT__: string | undefined;

export type BuildCommit =
  | { readonly kind: "commit"; readonly value: string }
  | { readonly kind: "source" }
  | { readonly kind: "unknown" };

export const resolveBuildCommit = (): BuildCommit => {
  if (typeof __T3CODE_BUILD_COMMIT__ === "undefined") return { kind: "source" };
  const value = __T3CODE_BUILD_COMMIT__.trim();
  return value === "" ? { kind: "unknown" } : { kind: "commit", value };
};

const describeBuildCommit = (commit: BuildCommit): string => {
  switch (commit.kind) {
    case "commit":
      return commit.value;
    case "source":
      return "source";
    case "unknown":
      return "unknown commit";
  }
};

/**
 * What `phoenix --version` reports: the package version plus the revision the
 * binary was built from, so an install running on a remote box can be matched
 * to a source commit without guessing from release dates.
 */
export const formatCliVersion = (
  version: string,
  commit: BuildCommit = resolveBuildCommit(),
): string => `${version} (${describeBuildCommit(commit)})`;
