# CI and publication policy

Phoenix keeps validation automatic and production publication manual. The source
workflow triggers express that policy; GitHub's enabled/disabled state is separate
and must be checked when changing operations. Historical claims that Release or
mobile production are disabled are not reliable configuration.

## Validation

[CI](../../.github/workflows/ci.yml) runs on PRs and main pushes with read-only
repository access: checks/typechecks, package and sharded server tests, Rust checks,
desktop build verification, and release smoke checks. Release configuration tests
reject partial Connect tuples and inherited hosted-web destinations.

Required branch checks must match the actual job names, including `Test Server 1`,
`Test Server 2`, `Test Server 3` and `Rust`. CI uses the checked-in Blacksmith runner
labels; runner access and sizing are infrastructure configuration. The mobile-native
analysis job remains explicitly parked with `false &&`; its detector is still wired.
Manual Windows Tests and Mobile Showcase Screenshots remain diagnostic/artifact
workflows rather than production publishers.

## Release boundary

[Release](../../.github/workflows/release.yml) and
[Mobile EAS Production](../../.github/workflows/mobile-eas-production.yml) accept
only `workflow_dispatch`. There are no cron, main-push or tag production releases.
Desktop/npm/hosted web publication uses one canonical Release workflow. The duplicate
Phoenix Build publisher and inherited hosted-relay deployment workflow were removed.
T3 Connect runtime/infra code and Cursor provider/dev integration remain in place;
Cursor's CI webhook/configuration removal does not remove the provider.

See [Releasing Phoenix](../operations/release.md) for dispatch controls, credentials,
public configuration, optional hosted web, and mobile build/update procedures.

## PR automation

Desktop and web previews remain label-driven, separate from production releases.
Mobile EAS Preview remains a preview-profile workflow. These optional workflows may
still be disabled in GitHub; source presence alone does not mean they run. Check
`gh workflow list --all --repo goodbirdhq/phoenix` before relying on an optional lane.
No cleanup here changes GitHub workflow settings.

Issue Labels manages issue-template labels. PR Size classifies PRs without executing
PR code in its privileged job; use its manual dispatch to synchronize label definitions.
The PR-only classification job is skipped on that dispatch, and label synchronization
keeps its existing issues-write permission. PR Vouch and Thread Transfer Report remain
optional; the latter reads trusted default-branch code and treats PR artifacts as data.
