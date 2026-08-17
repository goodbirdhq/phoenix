# Integrating upstream T3 Code

Phoenix integrates the full `pingdotgg/t3code` main branch twice a week. Each sync happens on a
fresh integration branch and is reviewed as a three-way semantic merge. The objective is not merely
to make Git accept the result: Phoenix behavior must survive while receiving every compatible
upstream improvement, including improvements to code Phoenix changed independently.

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

## 3. Review every textual conflict in three stages

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
- Follow-up risks that are real but not required to make the integration correct.

Commit the completed merge on the integration branch. Do not merge it into Phoenix `main`, push it,
or open a pull request unless a maintainer explicitly asks.

## Lessons from the first recurring integration

The August 17, 2026 integration demonstrated why both review queues are required:

- The textual conflicts were mostly small, but several needed additive resolutions: Phoenix session
  orchestration beside upstream browser-access settings, Phoenix reports beside upstream bounded
  activity hydration, and Phoenix identity beside upstream locale and preview-zoom support.
- Upstream's new mobile pairing helper merged cleanly while retaining the upstream URL scheme and
  Android package. The helper improvement was correct; its runtime identifiers had to be adapted.
- New DMG artwork merged cleanly with user-visible T3 Code text. Phoenix kept the artwork and changed
  only its runtime-facing copy.
- Upstream deleted checked-in desktop icons in favor of generated assets. Restoring Phoenix's stale
  fallback would have defeated that improvement, so the resolution removed the obsolete reference.
- Claude test fixtures merged cleanly but lacked a newly required request identifier. Package
  typechecking found the incomplete contract adaptation.
- Upstream redirected feature requests to its Discussions. Phoenix retained the improved issue
  guidance while routing users to the Phoenix tracker.
- Upstream wired its T3 Code AUR packages into the release workflow. Phoenix retained the packaging
  source as a reference, but removed the publishing workflow and release hook until the repository,
  assets, package names, credentials, and ownership are deliberately adapted together.
- The existing Phoenix install guide already linked to upstream distribution channels, and the
  merge added another one without a conflict. Reviewing the resulting user journey—not only newly
  added lines—caught and corrected the stale guidance.
- A browser-access setting was initially applied by withholding the entire shared MCP credential.
  That also removed Phoenix's independent session-orchestration tools and did not revoke access for
  an already-running process. Shared transports must stay attached; each capability needs its own
  dynamic authorization check at the tool boundary.
- An upstream mobile version bump merged cleanly, but Phoenix's push-triggered EAS workflow treated
  that value as a release command. App versions and deployment triggers are release-owned identity,
  not ordinary source updates. The upstream EAS workflow remains quarantined until every Expo and
  signing identifier is Phoenix-owned.
- A bare-letter right-panel shortcut checked whether a contenteditable contained text instead of
  whether the event originated in an editor. Empty composers are still typing targets. Shortcut
  guards should use element semantics, then be verified with a physical key event.
- Browser custom-protocol dispatch cannot report whether the external editor accepted the URL.
  Treating a dispatched navigation as a definite failure produced a false error on every successful
  Remote-SSH handoff. Model dispatched, refused, and unavailable outcomes separately when the host
  APIs can distinguish them.
- The dev runner and Vite proxy used different names for the same backend port. Unit tests covered
  environment construction but not the consumer. A real-client launch with the documented command
  caught the producer/consumer mismatch.

These examples are not a fixed list of expected conflicts. They illustrate the recurring decision:
preserve Phoenix intent, adopt the upstream improvement, and verify the combined behavior.
