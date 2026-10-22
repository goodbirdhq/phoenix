# Integrating upstream T3 Code

Phoenix integrates the full `pingdotgg/t3code` main branch regularly. Each sync happens on a fresh
integration branch and is reviewed as a three-way semantic merge. The objective is not merely to
make Git accept the result: Phoenix behavior must survive while receiving every compatible upstream
improvement, including improvements to code Phoenix changed independently.

Upstream owns the engine and Phoenix owns presentation and workflow. The
[divergence register](../internals/divergence.md) records who owns each area and every place
Phoenix differs from upstream; it is the starting point for every decision below. Reports for each
sync live in [upstream-integrations/](./upstream-integrations/). Integrations before 2026-10-21
predate Phoenix Reborn, the port onto upstream's V2, and describe a codebase that no longer exists.

## Non-negotiable rule

Do not resolve a conflict by choosing “ours” because Phoenix changed the file, or “theirs” because
upstream is newer. Establish three things first:

1. What behavior the common ancestor provided.
2. Which Phoenix requirement caused our branch to diverge.
3. Which bug fix, simplification, test, or new behavior upstream added afterward.

The resolution should preserve the Phoenix requirement using the best current implementation from
both branches. A prior Phoenix resolution is evidence, not permanent precedent.

The same review applies to files Git merges without a textual conflict. A clean merge can still
combine incompatible identifiers, retain a reference to a deleted asset, or leave one half of a
new interface on the old contract.

## 1. Pin the integration

Start from a clean, current Phoenix `main`. Configure the upstream remote once, then fetch without
changing `main`:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream main

phoenix_head=$(git rev-parse HEAD)
upstream_head=$(git rev-parse upstream/main)
merge_base=$(git merge-base "$phoenix_head" "$upstream_head")

git switch -c chore/sync-upstream-YYYY-MM-DD
git merge --no-commit --no-ff "$upstream_head"
```

Record all three hashes in the integration report. Never describe a sync only as “latest”; upstream
can move during review.

Check `merge_base` against the previous report's upstream head before going further. They should be
the same commit. A `merge_base` that is older means upstream ancestry was lost from `main` and this
sync is about to replay commits an earlier one already integrated; stop and
[record the ancestry](#7-record-upstream-ancestry-after-a-squash-merge) first.

Before resolving anything, capture the size of the divergence:

```bash
git rev-list --left-right --count "$phoenix_head...$upstream_head"
git diff --shortstat "$merge_base...$upstream_head"
git diff --name-only --diff-filter=U
```

## 2. Build the review inventory

The unresolved-file list is only the first queue. Build a second queue containing every file both
branches changed since the merge base:

```bash
comm -12 \
  <(git diff --name-only "$merge_base..$phoenix_head" | sort) \
  <(git diff --name-only "$merge_base..$upstream_head" | sort)
```

Review the upstream commits and classify them as:

- Product feature.
- Bug, reliability, security, or performance fix.
- Refactor or dependency change required by another upstream change.
- Patch-equivalent to a Phoenix implementation.
- Intentionally inapplicable to Phoenix.

Do not discard a commit solely because Phoenix has a feature with a similar title. Compare behavior,
edge cases, tests, supported clients, providers, and connection modes.

Run the divergence check before and after resolving, so the register and the tree are compared at
both ends of the sync:

```bash
node scripts/upstream-divergence.ts upstream/main
```

It groups every file that differs from upstream by owner and lists upstream-owned files that no
register row covers.

## 3. Review every textual conflict in three stages

Resolve by the ownership map in the [divergence register](../internals/divergence.md). In an
upstream-owned area, upstream's version is the base and the registered Phoenix extension is applied
to it again, adapted to what upstream changed. In a Phoenix-owned area, Phoenix's version is the
base and an upstream behavioral change is ported by hand when it matters. A conflict in an
upstream-owned file with no register row is a divergence nobody recorded: find its reason before
keeping it.

While a path remains unresolved, Git exposes the ancestor and both branch versions:

```bash
git show :1:path/to/file  # common ancestor
git show :2:path/to/file  # Phoenix
git show :3:path/to/file  # upstream
```

For each conflict, write a short resolution record:

| Field             | Question                                                 |
| ----------------- | -------------------------------------------------------- |
| Phoenix invariant | What user-visible or architectural behavior must remain? |
| Upstream delta    | What did upstream improve after the merge base?          |
| Resolution        | How does the merged code retain both intents?            |
| Verification      | Which focused test or static check proves it?            |

Common resolution patterns include:

- Keep Phoenix runtime identity while adopting upstream behavior and new interface fields.
- Keep a Phoenix feature flag and add the independent upstream flag beside it.
- Port a Phoenix delta into an upstream replacement module instead of restoring code upstream moved
  or deleted.
- Preserve a Phoenix extension while adopting upstream's stricter validation, bounded query, or
  broader provider/client handling.
- Replace two patch-equivalent implementations with the simpler current abstraction, retaining any
  Phoenix-only capability explicitly.

Avoid whole-file `ours` or `theirs` resolutions unless inspection proves the other side has no
relevant delta. They hide non-conflicting improvements in the same file.

## 4. Audit clean auto-merges

Walk the overlapping-file queue after textual conflicts are gone. Pay particular attention to:

- Runtime identity from [the branding policy](../internals/branding.md): app names, bundle IDs, URL
  schemes, state directories, ports, protocol origins, keychain names, updater repositories, desktop
  entries, services, and MCP server IDs.
- Files deleted or moved upstream that Phoenix still references.
- Schema and service additions where Phoenix independently added adjacent fields.
- Test fixtures whose inferred types changed without producing a conflict.
- Documentation, issue templates, package metadata, release artwork, and download links that can
  silently point Phoenix users back to upstream infrastructure.
- Release-owned values such as mobile app versions, deployment triggers, signing identities, Expo
  project IDs, npm package names, and updater repository URLs. A clean version change can trigger a
  real build or submission even when no workflow file conflicts.
- Duplicate implementations of the same feature. Decide precedence and fallback behavior rather
  than shipping two accidental defaults.
- Provider compatibility policies in `apps/server/src/provider/providerCompatibility.ts` match each
  policy's `t3CodeRange` against the server's `package.json` version, which release builds stamp
  with the Phoenix release version. Check that upstream's ranges still select the intended policies
  under Phoenix's numbering.
- `apps/server/src/provider/model-manifest.json`. Running servers fetch it hourly from Phoenix's
  `main` (`MODEL_MANIFEST_URL` in `ModelManifest.ts`), so take upstream's version on each sync and
  review its compatibility ranges; between syncs, new models reach users only when this file changes
  on `main`.

Search the staged delta for newly introduced upstream product identifiers, then classify each hit as
runtime identity, deliberate source identity, test data, or attribution. The branding policy's source
identity exceptions mean a blind repository-wide replacement is also incorrect.

## 5. Verify in layers

Verification should be proportional to the integration, but remain focused as required by
`AGENTS.md`:

1. `git diff --cached --check` and a conflict-marker search.
2. Typecheck the affected packages.
3. Run tests for every conflict and every Phoenix/upstream overlap with behavioral risk.
4. Run the tests protecting Phoenix-only invariants, even when their files merged cleanly.
5. Run upstream tests for moved abstractions, new settings, and dependency-driven behavior.
6. Perform a real-client pass only when requested, following the repository's browser/computer-use
   permission rule.

If upstream added dependencies, refresh the workspace from the merged lockfile before treating a
missing module as a code defect.

Do not commit with unresolved warnings introduced by the integration. Existing unrelated warnings
may be recorded, but the integration must not add new ones.

## 6. Finish the branch

Update the [divergence register](../internals/divergence.md) so it describes the merged tree: add a
row for every divergence the sync introduced, rewrite rows whose paths or re-apply steps changed,
and delete rows for divergences upstream made unnecessary. Run the divergence check again; it should
report no unregistered engine divergence.

Before committing:

```bash
git status --short
git diff --cached --check
git diff --cached --stat
```

The integration report should include:

- Phoenix head, upstream head, and merge base.
- Commit/file counts and conflict count.
- Features and fixes received.
- Every conflict decision.
- Important clean-merge decisions.
- Intentional exclusions and why they do not apply.
- Commands run and their results.
- Register rows added, changed, or removed, and the divergence check's final output.
- Follow-up risks that are real but not required to make the integration correct.

Commit the completed merge on the integration branch. Do not merge it into Phoenix `main`, push it,
or open a pull request unless a maintainer explicitly asks.

## 7. Record upstream ancestry after a squash merge

Squash-merging an integration pull request keeps the files and discards the second parent, so
upstream's history stops being reachable from `main`. Nothing looks wrong until the next sync,
which computes its merge base from that history: it resolves to the base of the sync before last,
and the integration replays every commit the squashed pull request already handled. Those replays
arrive as conflicts against code that already holds their resolutions, and the Phoenix adaptations
inside them — identity, quarantines, conflict decisions — all come up for re-litigation.

After a squashed integration lands, record the ancestry on `main`:

```bash
git switch -c ancestry-<upstream_head> origin/main
git merge -s ours "$upstream_head" -m "chore: record upstream ancestry through <upstream_head>"
```

Prove it changed nothing before it goes anywhere:

```bash
test "$(git rev-parse HEAD^{tree})" = "$(git rev-parse origin/main^{tree})"  # identical trees
git merge-base --is-ancestor "$upstream_head" HEAD                           # ancestry restored
git merge-base HEAD upstream/main                                            # now the upstream head
```

The tree must be identical: this commit exists to carry a parent, not a change. Push it to `main`
only when a maintainer asks, the same as any other write to the default branch.

A merge-commit merge needs none of this, and is the better default for integration pull requests
where the repository allows it.
