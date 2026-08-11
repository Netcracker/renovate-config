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
- Version pins may proceed when Renovate cannot attach a release timestamp.
- Track this limitation in [Renovate issue #40288](https://github.com/renovatebot/renovate/issues/40288).
- Docker digest updates still wait seven days when a registry provides a timestamp but may proceed when it does not.
- Digest pinning proceeds immediately because it only freezes a mutable reference already in use.
- `osvVulnerabilityAlerts: true` enables OSV.dev in addition to GitHub Security Advisories.
- Security updates bypass the seven-day delay. The `vulnerabilityAlerts` block opens vulnerability PRs immediately.
- Go toolchain and official `golang.org/x/*` updates bypass the delay. Other Go module dependencies keep the standard
  seven-day delay.
- Groups all `actions/*` GitHub Actions updates into a single PR titled `actions org`.
- Temporarily disables Renovate updates for the SHA-pinned `IEvangelist/profanity-filter` Action only when Renovate
  extracts the broken `13.4.6` or `v13.4.6` value from its four-component version comment. Other versions remain
  enabled. Remove this exception after the exact published tag or alias resolves successfully and the shared workflow
  uses that reference. Upstream progress is tracked in
  [IEvangelist/profanity-filter#168](https://github.com/IEvangelist/profanity-filter/issues/168).

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
- `go-catch-all` groups minor and patch updates for Go modules not covered by the `go` or `netcracker-dependencies`
  presets. Major updates remain separate.
- `go-tidy` runs `go mod tidy` after Go module updates.
- `maven-groupid` groups Maven updates by `groupId`. Maven vulnerability updates use the same grouping, while
  vulnerability updates from other ecosystems remain separate by datasource and dependency.
- `netcracker-dependencies` groups internal dependencies by ecosystem and removes their release-age delay.
- `annotated-versions` updates annotated Docker, YAML, template, Makefile, and environment values and `go install` commands. Version-only Docker annotations use tags without adding digests. Digest-pinned images in Helm print templates keep their tags and digests aligned.
- `test-pipelines` keeps reusable test pipeline workflow references and `pipeline_branch` inputs aligned.
- `grafana-plugins` updates Grafana plugin ID and version pairs in `plugins.list`, including plugins whose Grafana API response contains only one release.
- `graylog-plugins` updates GitHub release URLs for Graylog plugin JARs in `plugins.list`.
- `apm` updates APM package references in `apm.yml`.

The `go-tidy` preset is separate because `gomodTidy` can make changes to `go.mod` and `go.sum` that are unrelated to
the dependency Renovate is updating. Enable it only when those broader module-file changes are acceptable.

The `go-catch-all` preset is separate because grouping unrelated Go modules trades smaller PR volume for a larger
validation scope. Enable it only when the repository wants one PR for unrelated minor and patch updates:

```json
{
  "extends": [
    "github>Netcracker/renovate-config:go",
    "github>Netcracker/renovate-config:netcracker-dependencies",
    "github>Netcracker/renovate-config:go-catch-all"
  ]
}
```

## Group Maven updates by groupId

Enable the `maven-groupid` preset to group Maven artifacts that share a `groupId`:

```json
{
  "extends": ["github>Netcracker/renovate-config:maven-groupid"]
}
```

For example, updates for `org.apache.logging.log4j:log4j-api` and
`org.apache.logging.log4j:log4j-core` use one `org.apache.logging.log4j` group. The preset applies the same grouping to
Maven vulnerability updates.

Repository package rules can override the default group. Keep local rules that combine multiple groupIds, constrain
versions, or apply only to specific files.

For ordinary updates, place `netcracker-dependencies` after `maven-groupid` so internal Maven artifacts retain the
shared `Netcracker Maven artifacts` group:

```json
{
  "extends": [
    "github>Netcracker/renovate-config:maven-groupid",
    "github>Netcracker/renovate-config:netcracker-dependencies"
  ]
}
```

Vulnerability updates always use the `<groupId> security` group, including internal artifacts. Renovate applies
`vulnerabilityAlerts` after ordinary package rules, so preset order does not change security grouping.

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

Keep `annotated-versions` after `base` in the `extends` list. The `base` preset enables digest pinning for Docker dependencies. The `annotated-versions` preset disables it only for version-only Docker annotations because those fields have nowhere to store a digest.

Dependencies extracted by Renovate's native `dockerfile` and `helm-values` managers, along with custom managers that extract a digest, retain the inherited digest policy.

### Pin annotated Helm image defaults by digest

Add a digest to a full image reference in a Helm print template to opt in to digest updates:

```gotemplate
{{- /* # renovate: datasource=docker depName=graylog/graylog */ -}}
{{- print "docker.io/graylog/graylog:5.2.12@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" -}}
```

Renovate extracts both the tag and digest and updates them together. A template that contains only a tag continues to receive tag-only updates.

Seed the first valid digest manually. The preset requires an existing `@sha256:...` value instead of relying on initial digest insertion by a regex manager, which remains tracked in [renovatebot/renovate#10993](https://github.com/renovatebot/renovate/issues/10993).

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

[`apm.json`](./apm.json) detects APM package references in `apm.yml` files. It handles dependencies and marketplace
sources differently because only dependencies are covered by `apm.lock.yaml`.

Design notes:

- Dependencies use a tag such as `package#v1.2.0`. Renovate advances the tag, while `apm.lock.yaml` stores the resolved
  commit SHA. Dependency branch refs such as `package#main` remain unchanged.
- A legacy dependency pin such as `package#<sha>  # v1.2.0` becomes `package#v1.3.0` on its first tag update. The
  dependency SHA remains in `apm.lock.yaml`.
- Marketplace sources use an immutable SHA with a source-ref comment, such as `ref: <sha>  # v1.2.0` or
  `ref: <sha>  # main`, because `apm.lock.yaml` does not cover these entries.
- Marketplace release updates change both the SHA and the semantic-version tag. Marketplace branch updates change the
  SHA to the branch head and keep the branch comment.
- APM updates remain under manual review.

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
