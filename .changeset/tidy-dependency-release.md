---
"toto-stack": minor
"create-toto-app": minor
---

Breaking: raise the minimum Node.js version from 22.12 to 22.22.0. Upgrade Node before installing this release or scaffolding an app.

Refresh runtime, client and build dependencies, including Express, Chalk 6, React Router 8, Vite 8 and the Node 26 container image. Update lint tooling together for ESLint 10 compatibility and retain TypeScript 5 while typescript-eslint does not support TypeScript 7.

Serve SPA deep links correctly when the public directory has a hidden deployment parent, without relaxing public-root dotfile protection.
