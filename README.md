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
- `go` groups Kubernetes and OpenShift, OpenTelemetry, Prometheus, and Go toolchain updates. Toolchain updates include
  `go.mod` directives, explicit GitHub Actions Go versions, and official `golang` builder images. The preset does not
  group unrelated dependencies or the `actions/setup-go` action version.
- `go-tidy` runs `go mod tidy` after Go module updates.
- `netcracker-dependencies` groups internal dependencies by ecosystem and removes their release-age delay.
- `annotated-versions` updates annotated Docker, YAML, template, Makefile, and environment values and `go install` commands.
- `test-pipelines` keeps reusable test pipeline workflow references and `pipeline_branch` inputs aligned.
- `grafana-plugins` updates Grafana plugin ID and version pairs in `plugins.list`, including plugins whose Grafana API response contains only one release.
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

## Update Alpine package annotations with the base image

Use this feature when a Dockerfile uses an official Alpine image and pins APK package versions through Repology.

Enable the `annotated-versions` preset:

```json
{
  "extends": ["github>Netcracker/renovate-config:annotated-versions"]
}
```

Add `syncWith=alpine` to each package annotation associated with the Alpine image:

```dockerfile
FROM alpine:3.24.1

# renovate: datasource=repology depName=alpine_3_24/busybox versioning=apk syncWith=alpine
ARG BUSYBOX_VERSION=1.37.0-r31
```

When Renovate updates Alpine 3.24 to 3.25, the same PR also makes this change:

```dockerfile
FROM alpine:3.25.0

# renovate: datasource=repology depName=alpine_3_25/busybox versioning=apk syncWith=alpine
ARG BUSYBOX_VERSION=1.37.0-r31
```

The synchronization changes the Alpine image and the Repology repository. It does not change the pinned package version. Repology does not provide release timestamps, so Alpine Repology updates bypass the organization release-age delay.

Renovate does not try to add an image digest to the synchronization annotation because the annotation has no digest field. The Docker build verifies that the package version exists in the new Alpine release.

Do not add `syncWith=alpine` to packages installed in derived images such as `golang:1.26-alpine3.24`. Their Alpine
release is part of the derived image tag and may differ from the official Alpine image.

A repository rule that groups all Docker updates can override the `alpine-release` group. Place this rule after any
broader Docker grouping rules:

```json
{
  "packageRules": [
    {
      "matchDatasources": ["docker"],
      "matchPackageNames": ["alpine"],
      "groupName": "alpine-release"
    }
  ]
}
```

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

[`apm.json`](./apm.json) detects APM package references in `apm.yml` files and proposes semantic-version bumps for
tag-tracked entries via the `github-tags` datasource. It covers the `dependencies.apm` list (`package#v1.2.0`) and the
`marketplace.packages` block (`ref: v1.2.0`).

Design notes:

- `apm.yml` records only a version tag or a branch name. Resolved commit SHAs live in `apm.lock.yaml`, produced by
  `apm install`, not in `apm.yml`.
- Tag refs advance to newer semantic-version tags (for example `v0.1.0` → `v1.0.1`).
- Branch refs (`package#main`, `ref: main`) are left untouched; a branch carries no version to bump.
- When an entry still carries a legacy `#<sha>  # v0.1.0` pin, the first tag bump rewrites it to a clean `#v0.1.0` and
  drops the SHA. The preset never writes a digest back into `apm.yml`.

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
