# Renovate Configuration

This repository hosts the **shared Renovate configuration** used across all repositories in the `Netcracker` GitHub organization.

## How it is applied

The Mend Renovate App is configured at the organization level with **Inherited Config** enabled. On every run, Mend reads [`org-inherited-config.json`](./org-inherited-config.json) from this repository (defaults: `inheritConfigRepoName=renovate-config`, `inheritConfigFileName=org-inherited-config.json`) and merges it as the base layer for every repository in the org.

**You do not need to add anything to your repository to receive these defaults.** Any existing `renovate.json` / `renovate.json5` in your repo is layered on top and can override the inherited values.

## What the inherited config does

- Extends [`config:best-practices`](https://docs.renovatebot.com/presets-config/#configbest-practices) — recommended baseline plus Dependency Dashboard, config migration PRs, dev-dependency pinning, and SHA-pinned GitHub Actions with semver hints.
- `minimumReleaseAge: "7 days"` — delays updates until a release has been public for one week, so freshly-published broken or compromised versions are not proposed.
- `internalChecksFilter: "strict"` — when the newest version is still inside the 7-day window, Renovate proposes the latest version that has already matured rather than opening a PR marked "pending".
- `osvVulnerabilityAlerts: true` — enables the OSV.dev source for CVEs in addition to GitHub Security Advisories.
- **Security updates bypass the 7-day delay.** The `vulnerabilityAlerts` block opens vulnerability PRs immediately (`minimumReleaseAge: null`, `prCreation: "immediate"`, `schedule: ["at any time"]`).
- Groups all `actions/*` GitHub Actions updates into a single PR titled `actions org`.

## Overriding for a specific repository

If a repository needs to deviate from the org defaults, add a `renovate.json` in that repository. Repo-local settings win on conflicts. Example:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "minimumReleaseAge": "3 days"
}
```

To opt a repository out entirely, set `"enabled": false` (or remove the Mend installation from that repo).

## `default.json` preset

[`default.json`](./default.json) is a small explicit preset (`extends: ["config:recommended"]`) provided for the rare case where a repository wants to opt into a named preset via `"extends": ["github>Netcracker/renovate-config"]`. It is **not** what powers the automatic inheritance described above — that comes from `org-inherited-config.json`.

## Changing the org-wide config

Open a PR against `org-inherited-config.json`. Once merged to `main`, the next Renovate run on any repository in the org picks up the new values automatically.

## References

- [Renovate — Inherited Presets](https://docs.renovatebot.com/config-presets/#inherited-presets)
- [Renovate — `config:best-practices`](https://docs.renovatebot.com/presets-config/#configbest-practices)
- [Renovate — `vulnerabilityAlerts`](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts)
