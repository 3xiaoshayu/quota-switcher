# Release Process

User-facing copy is in Chinese. This page is for people cutting a release.

Releases are built by GitHub Actions on `windows-latest`. Do not upload a
locally built installer as an official release asset.

## Channels

- `x.y.z-beta.n`: prerelease, manual updates in the application.
- `x.y.z`: stable release, eligible for automatic update checks.

Stable releases should not be created until code signing, update behavior, and
migration from the latest beta have been verified.

## Prepare a release

1. Start from a clean `main` branch.
2. Update the version in `package.json` and `package-lock.json`.
3. Add a dated section to `CHANGELOG.md`.
4. Run:

```powershell
npm ci
npm test
npm run build:windows
```

5. Install the generated Setup executable on a clean Windows user profile.
6. Verify launch, Codex and Cursor detection, read-only account display,
   sidebar product switching, navigation, and uninstall behavior.
7. Do not use real destructive account actions during release smoke testing.
   Do not complete OAuth or switch a live official client.

## Publish

Commit the release metadata:

```powershell
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v<version>"
git push origin main
```

Create an annotated tag that exactly matches `package.json`:

```powershell
git tag -a v<version> -m "Codex Account Manager v<version>"
git push origin v<version>
```

The Release workflow:

1. installs locked dependencies with `npm ci`;
2. runs engine behavior tests and verifies the renderer/preload/IPC contract;
3. verifies release metadata and the tag/version match;
4. builds x64 NSIS and ZIP artifacts;
5. creates `SHA256SUMS.txt`;
6. creates or updates the matching GitHub Release.

## Expected assets

- `Codex-Account-Manager-Setup-<version>-x64.exe`
- `Codex-Account-Manager-<version>-x64.zip`
- installer `.blockmap`
- `latest.yml`
- `SHA256SUMS.txt`
- GitHub-generated source archives

Only the Setup executable is recommended for most users. The blockmap and
`latest.yml` are updater metadata.

## Release notes

Release notes should contain:

- the user-visible changes;
- install or migration notes;
- known limitations;
- the unsigned-build warning while applicable;
- a link to `CHANGELOG.md`;
- a statement that account data remains local.

Do not include real account identifiers, local paths, logs, or internal test
credentials.

## Rollback

Do not move an existing release tag. If a published artifact is defective:

1. mark the release as a prerelease or add a clear warning;
2. fix the issue on `main`;
3. publish a new patch or beta number;
4. leave the original tag immutable for auditability.
