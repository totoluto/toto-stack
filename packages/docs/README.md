# Documentation site

The private `toto-docs` workspace builds the documentation with Astro Starlight. It is not published to npm or included in generated apps.

From the repository root:

```sh
npm ci
npm run docs:dev
npm run docs:check
```

Open the URL printed by Astro, including `/toto-stack/`. `docs:check` runs the HTTP route coverage tests, compares endpoint documentation with source registrations, checks Astro/TypeScript, generates the public API reference, validates internal links and builds the searchable static site. `npm run docs:build` only generates and builds; `npm run preview -w toto-docs` serves the built output.

## Editing

- Edit guides in `src/content/docs/`. Give each page a title, description and sidebar order.
- Edit HTTP contracts in `src/content/docs/http/`. Each endpoint heading must contain its exact method and `/api` path; the coverage checker catches missing, stale and duplicate routes. It checks route coverage, not response correctness. Review behavior against the implementation and HTTP tests.
- TypeScript reference pages under `src/content/docs/api/` are generated from the three public entry points in `packages/stack/src/`. Improve source comments instead of editing generated pages. These files are ignored by Git.
- Keep styles in `src/styles/custom.css`. Its dark tokens follow the template's charcoal/indigo palette; do not import the application's global rules into the site.
- Preview changes to code samples, tables and navigation on both desktop and mobile. Internal links must work under the `/toto-stack/` base path.

The header reads the package version from the stack manifest. The site follows `master` and explicitly labels potentially unreleased content; it does not claim to be a versioned archive.

## GitHub Pages

One-time maintainer setup, before merging the documentation PR:

1. In repository Settings → Pages, select **GitHub Actions** as the build source.
2. If the `github-pages` environment has deployment restrictions, allow `master`.

The Documentation workflow validates all pull requests and uploads a `documentation-site` review artifact. Pull requests never deploy. A successful build on `master` publishes to `https://totoluto.github.io/toto-stack/`; the workflow can also be dispatched manually on `master`. No application server, database, npm publishing credentials or personal access token is needed.

For a future custom domain, update `site`/`base` in `astro.config.mjs` and the internal base-prefixed links together, then configure the domain in Pages. Test direct page URLs and search after changing the base path.

The documentation uses Astro 6/Starlight 0.40 to keep the repository's Node 22.22.0 minimum intact. Upgrade that toolchain as a compatible set, not through forced peer resolutions.
