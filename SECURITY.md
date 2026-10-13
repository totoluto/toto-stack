# Security policy

<!--
Maintainer TODO before publishing:
- GitHub private vulnerability reporting only exists for PUBLIC repositories.
  Making the repository public is a maintainer decision. After that, enable it
  under Settings -> Code security -> Private vulnerability reporting.
- Replace the fallback contact placeholder below with a monitored address.
-->

`toto-stack` is a security-focused framework, and we take reports seriously. Thank you for helping keep its users safe.

## Supported versions

Until 1.0, only the **latest 0.x minor line** receives security fixes. When 0.3.0 is released, for example, 0.2.x stops receiving them.

| Version | Supported |
|---|---|
| latest 0.x minor (e.g. 0.2.x while 0.2 is current) | yes |
| older 0.x minors | no, upgrade (see [docs/upgrading.md](docs/upgrading.md)) |

`toto-stack` and `create-toto-app` share version numbers, and the policy applies to both.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a vulnerability.**

1. **Preferred:** GitHub private vulnerability reporting. On the repository's **Security** tab, choose **Report a vulnerability** (https://github.com/totoluto/toto-stack/security/advisories/new).
2. **Fallback**, if private reporting isn't available to you: email `<security contact — to be filled in by the maintainer>`.

Please include:
- the affected package(s) and version(s);
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept (a minimal app or request sequence is ideal);
- any suggested fix or mitigation;
- whether and how you want to be credited.

Test only against your own installations. Don't access other people's data or degrade services you don't own.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| Initial assessment (confirmed or not, severity) | within 10 business days |
| Fix released for critical and high severity issues | within 30 days of confirmation |
| Fix released for medium and low severity issues | in a following release, typically within 90 days |

These are targets, not guarantees, for a project maintained on a best-effort basis. We will keep you informed of progress and tell you if a target slips.

## Coordinated disclosure

- We fix the issue privately, in a GitHub security advisory and a private fork, and release patched versions of the affected packages.
- We then publish the advisory, with a CVE where applicable, crediting you unless you prefer otherwise.
- Please keep the details confidential until the advisory is published, or until 90 days after your report, whichever comes first. If a fix needs longer, we'll agree on a new date with you.
- If the issue is actively exploited, we may publish mitigations earlier.

## Scope

**In scope:**
- The `toto-stack` package: server, client and shared entries.
- The `create-toto-app` CLI.
- The app template it generates: Docker/Compose files, server entry, client authentication screens.

**Out of scope:**
- Vulnerabilities in your own application code.
- Insecure deployment choices that the documentation warns against: running production over plain HTTP, `TRUST_PROXY=true`, or exposing the database.
- Vulnerabilities in third-party dependencies that don't affect toto-stack. Report those upstream; we'll still update the dependency.

[docs/security.md](docs/security.md) describes the security model and documents its known limitations.
