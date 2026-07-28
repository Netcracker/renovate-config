# Renovate Configuration

This repository hosts the **shared Renovate configuration** used across all repositories in the `Netcracker` GitHub
organization.

## How it is applied

The Mend Renovate App is configured at the organization level with **Inherited Config** enabled. On every run, Mend
reads [`org-inherited-config.json`](./org-inherited-config.json) from this repository and merges it as the base layer
for every repository in the organization.

**You do not need to add anything to your repository to receive these defaults.** Any existing `renovate.json` or
`renovate.json5` in your repository is layered on top and can override the inherited values.

## What the inherited config does

- Extends [`config:best-practices`](https://docs.renovatebot.com/presets-config/#configbest-practices), which provides
  the recommended baseline, Dependency Dashboard, config migrations, dev-dependency pinning, and SHA-pinned GitHub
  Actions with semver hints.
- `minimumReleaseAge: "7 days"` delays updates until a release has been public for one week.
- `internalChecksFilter: "strict"` proposes the latest mature version while a newer release is still inside the
  release-age window.
- `osvVulnerabilityAlerts: true` enables OSV.dev in addition to GitHub Security Advisories.
- Security updates bypass the seven-day delay. The `vulnerabilityAlerts` block opens vulnerability PRs immediately.
- Go toolchain and official `golang.org/x/*` updates bypass the delay. Other Go module dependencies keep the standard
  seven-day delay.
- Groups all `actions/*` GitHub Actions updates into a single PR titled `actions org`.

## Overriding for a specific repository

If a repository needs to deviate from the organization defaults, add a `renovate.json` in that repository.
Repository-local settings win on conflicts. Example:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "minimumReleaseAge": "3 days"
}
```

To opt a repository out entirely, set `"enabled": false` (or remove the Mend installation from that repo).

## `default.json` preset

[`default.json`](./default.json) is a small explicit preset (`extends: ["config:recommended"]`) for a repository that
opts into `"github>Netcracker/renovate-config"`. The automatic inheritance described above comes from
`org-inherited-config.json`.

## Capability presets

Capability presets are additive and opt-in. Compose only the capabilities that a repository needs instead of extending
a team-specific preset:

- `base` applies an explicit best-practices baseline, weekly schedule, dependency label, and semantic commit settings.
- `github-actions` groups third-party and Netcracker actions separately, with major updates in separate groups.
- `go` groups Kubernetes, OpenTelemetry, Prometheus, and Go toolchain updates. It does not group unrelated modules.
- `go-tidy` runs `go mod tidy` after Go module updates.
- `netcracker-dependencies` groups internal dependencies by ecosystem and removes their release-age delay.
- `annotated-versions` updates explicitly annotated Docker, YAML, template, and Makefile values.
- `test-pipelines` keeps reusable test pipeline workflow references and `pipeline_branch` inputs aligned.
- `grafana-plugins` updates Grafana plugin ID and version pairs in `plugins.list`.
- `graylog-plugins` updates GitHub release URLs for Graylog plugin JARs in `plugins.list`.
- `apm` updates APM package references in `apm.yml`.

The `go-tidy` preset is separate because `gomodTidy` can make changes to `go.mod` and `go.sum` that are unrelated to
the dependency Renovate is updating. Enable it only when those broader module-file changes are acceptable.

For example, a Go repository that uses annotated tool versions can compose these presets:

```json
{
  "extends": [
    "github>Netcracker/renovate-config:base",
    "github>Netcracker/renovate-config:github-actions",
    "github>Netcracker/renovate-config:go",
    "github>Netcracker/renovate-config:netcracker-dependencies",
    "github>Netcracker/renovate-config:annotated-versions"
  ]
}
```

Add `"github>Netcracker/renovate-config:go-tidy"` only as an explicit repository decision.

## `test-pipelines.json` preset

[`test-pipelines.json`](./test-pipelines.json) updates annotated `pipeline_branch` inputs in GitHub Actions workflows.
It complements Renovate's built-in `github-actions` manager, which updates the reusable workflow reference.

Enable the preset in the repository Renovate configuration:

```json
{
  "extends": ["github>Netcracker/renovate-config:test-pipelines"]
}
```

Add the release tag and package annotation after each pinned `pipeline_branch` commit:

```yaml
pipeline_branch: 'ddc741b38bac5dc4834b8f6827c9f6d16abf0db8' # v1.14.1 renovate: depName=Netcracker/qubership-test-pipelines
```

## `apm.json` preset

[`apm.json`](./apm.json) detects APM package references in `apm.yml` files. It updates package references pinned to
GitHub release tags, package references pinned to immutable Git SHAs with a source-ref comment, mutable package
references that still need a SHA pin, and marketplace entries that use `source`, `subdir`, and `ref`.

Use it from a repository-local config:

```json
{
  "extends": ["github>Netcracker/renovate-config:apm"]
}
```

## Changing the org-wide config

Open a PR against `org-inherited-config.json`. Once merged to `main`, the next Renovate run on any repository in the
organization picks up the new values automatically.

## References

- [Renovate — Inherited Presets](https://docs.renovatebot.com/config-presets/#inherited-presets)
- [Renovate — `config:best-practices`](https://docs.renovatebot.com/presets-config/#configbest-practices)
- [Renovate — `vulnerabilityAlerts`](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts)
