# Releasing

`toto-stack` and `create-toto-app` are released together with [Changesets](https://changesets.dev). They always have the same version (a `fixed` group), because the CLI scaffolds apps that depend on `toto-stack@^<CLI version>`. The template workspace (`toto-app`) is private and never published on its own.

## Day to day

1. A PR that changes a published package adds a changeset: `npm run changeset`, then pick the bump. While on 0.x, use `minor` for breaking changes and `patch` for everything else.
2. On every push to `master`, [`release.yml`](workflows/release.yml) opens or updates a **"chore(release): version packages"** PR. It bumps both versions, writes `packages/*/CHANGELOG.md`, updates the template's `toto-stack` range and refreshes the lockfile (`npm run version-packages`).
3. Merging that PR triggers the publish path. If publishing is enabled, the workflow runs the full check (`npm run check`) on the merged commit, packs both packages, and publishes them via npm trusted publishing with provenance. It then pushes the `toto-stack@x.y.z` / `create-toto-app@x.y.z` tags and creates GitHub releases.

PRs opened by the workflow's `GITHUB_TOKEN` don't trigger CI. The publish job re-runs the checks itself. To get CI on the version PR as well, pass a GitHub App or fine-grained token to `changesets/action/version` (`github-token`).

## One-time setup (maintainer)

Nothing is published until all of this is done.

1. **Make the repository public.** npm can't generate provenance for private repositories. The publish step sets `NPM_CONFIG_PROVENANCE=true`, so it fails rather than publish without provenance.
2. **First publish, by hand, at 0.1.0.** Trusted publishers can only be configured for packages that already exist. With 2FA enabled on your npm account:
   ```sh
   npm ci
   npm run check
   npx changeset publish   # publishes 0.1.0 of both, asks for the OTP, creates the git tags
   git push --follow-tags
   ```
   Don't merge a version PR before this, or the first version becomes 0.1.1.
3. **Configure trusted publishing** on npmjs.com, under each package's Settings → Trusted publishing, for both `toto-stack` and `create-toto-app`:
   - Publisher: GitHub Actions
   - Organization/user: `totoluto`
   - Repository: `toto-stack`
   - Workflow filename: `release.yml`
   - Environment: `npm`

   Then set "Publishing access" to *Require two-factor authentication and disallow tokens*.
4. **Create the `npm` environment** (Settings → Environments). Restrict deployment branches to `master` and, optionally, add required reviewers to approve each publish.
5. **Allow the workflow to open PRs:** Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests".
6. **Enable publishing:** Settings → Secrets and variables → Actions → Variables → `NPM_PUBLISH_ENABLED` = `true`.

## Code scanning

[`codeql.yml`](workflows/codeql.yml) runs on every PR. Until code scanning is enabled, its results are attached to the run (summary, warning annotations, `codeql-sarif` artifact) instead of being uploaded. To enable uploads, turn on code scanning (Settings → Code security; free once the repository is public), then set the repository variable `CODE_SCANNING_ENABLED` = `true`.
