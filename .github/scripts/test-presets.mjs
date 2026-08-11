import assert from 'node:assert/strict';
import fs from 'node:fs';

const presetNames = [
  'base',
  'github-actions',
  'go',
  'go-catch-all',
  'go-tidy',
  'maven-groupid',
  'netcracker-dependencies',
  'test-pipelines',
  'annotated-versions',
  'grafana-plugins',
  'graylog-plugins',
];

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function readFixture(path) {
  return fs.readFileSync(`tests/fixtures/${path}`, 'utf8');
}

function findRule(config, description) {
  const rule = config.packageRules?.find((candidate) => {
    const value = Array.isArray(candidate.description) ? candidate.description.join(' ') : candidate.description;
    return value?.includes(description);
  });
  assert.ok(rule, `Package rule not found: ${description}`);
  return rule;
}

function matchesStringPattern(pattern, value) {
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1)).test(value);
  }
  if (pattern.endsWith('/**')) {
    return value.startsWith(pattern.slice(0, -2));
  }
  return pattern === value;
}

function matchesStringPatterns(patterns, value) {
  const negativePatterns = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
  if (negativePatterns.some((pattern) => matchesStringPattern(pattern, value))) {
    return false;
  }
  const positivePatterns = patterns.filter((pattern) => !pattern.startsWith('!'));
  return positivePatterns.length === 0 || positivePatterns.some((pattern) => matchesStringPattern(pattern, value));
}

function ruleMatchesDependency(rule, dependency) {
  const arrayMatchersMatch = [
    ['matchManagers', dependency.manager],
    ['matchDatasources', dependency.datasource],
    ['matchPackageNames', dependency.packageName ?? dependency.depName],
    ['matchDepNames', dependency.depName],
    ['matchDepTypes', dependency.depType],
    ['matchUpdateTypes', dependency.updateType],
  ].every(([matcher, value]) => !rule[matcher] || matchesStringPatterns(rule[matcher], value));
  const currentValueMatches =
    !rule.matchCurrentValue || matchesStringPatterns([rule.matchCurrentValue], dependency.currentValue);
  return arrayMatchersMatch && currentValueMatches;
}

function applyPackageRules(dependency, rules) {
  return rules.reduce(
    (result, rule) => (ruleMatchesDependency(rule, dependency) ? { ...result, ...rule } : result),
    dependency
  );
}

function compileManager(manager) {
  return manager.matchStrings.map((matchString) => new RegExp(matchString, 'g'));
}

function managerMatchesPath(manager, path) {
  return manager.managerFilePatterns.some((pattern) => {
    const negative = pattern.startsWith('!');
    const regexPattern = negative ? pattern.slice(1) : pattern;
    assert.match(regexPattern, /^\/.+\/$/, `Test runner does not support non-regex file pattern: ${pattern}`);
    const matched = new RegExp(regexPattern.slice(1, -1)).test(path);
    return negative ? !matched : matched;
  });
}

function extract(manager, content) {
  return compileManager(manager).flatMap((regex) => [...content.matchAll(regex)].map((match) => match.groups));
}

function extractRuntimeDependencies(manager, content) {
  const validMatchFields = [
    'depName',
    'packageName',
    'currentValue',
    'currentDigest',
    'datasource',
    'versioning',
    'extractVersion',
    'registryUrl',
    'depType',
    'indentation',
  ];

  return compileManager(manager).flatMap((regex) =>
    [...content.matchAll(regex)].map((match) => {
      const dependency = {};
      for (const field of validMatchFields) {
        const template = manager[`${field}Template`];
        const value = template ? render(template, match.groups) : match.groups[field];
        if (value !== undefined) {
          dependency[field] = value;
        }
      }
      dependency.replaceString = match[0];
      return dependency;
    })
  );
}

function replaceRegexDependency(manager, content, dependencyIndex, newValue, newDigest) {
  const matches = compileManager(manager).flatMap((regex) => [...content.matchAll(regex)]);
  const match = matches[dependencyIndex];
  assert.ok(match, `Dependency index ${dependencyIndex} was not found`);

  const replacement = match[0]
    .replace(match.groups.currentValue, newValue)
    .replace(match.groups.currentDigest, newDigest);
  return `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
}

function render(template, values) {
  return template
    .replaceAll(
      /\{\{#if \(equals ([^ ]+) '([^']+)'\)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, field, expected, ifTrue, ifFalse) => (values[field] === expected ? ifTrue : ifFalse)
    )
    .replaceAll(
      /\{\{\{\s*replace '([^']+)' '([^']*)' ([^}]+)}}}/g,
      (_, pattern, replacement, field) => (values[field.trim()] ?? '').replace(new RegExp(pattern), replacement)
    )
    .replaceAll(/\{\{\{([^}]+)}}}/g, (_, field) => values[field] ?? '');
}

function assertBasePolicy(config) {
  assert.deepEqual(config.extends, ['config:best-practices', 'schedule:weekly']);
  assert.deepEqual(config.labels, ['dependencies']);
  assert.equal(config.semanticCommits, 'enabled');
  assert.equal(config.semanticCommitType, 'chore');
  assert.equal(config.semanticCommitScope, 'deps');
  assert.equal('automerge' in config, false, 'base.json must not configure automerge');
}

function assertGitHubActionsPolicy(config) {
  const thirdParty = findRule(config, 'Group third-party GitHub Actions');
  const netcracker = findRule(config, 'Group Netcracker GitHub Actions');
  const majorThirdParty = findRule(config, 'Group third-party GitHub Actions major updates separately');
  const majorNetcracker = findRule(config, 'Group Netcracker GitHub Actions major updates separately');
  const nonMajorUpdateTypes = ['minor', 'patch', 'pin', 'digest', 'pinDigest'];
  assert.deepEqual(thirdParty.matchManagers, ['github-actions']);
  const thirdPartyDepNames = [
    '!go',
    '!golang',
    '!docker.io/library/golang',
    '!index.docker.io/library/golang',
    '!registry-1.docker.io/library/golang',
  ];
  assert.deepEqual(thirdParty.matchPackageNames, ['!Netcracker/**', '!netcracker/**']);
  assert.deepEqual(majorThirdParty.matchPackageNames, ['!Netcracker/**', '!netcracker/**']);
  assert.deepEqual(thirdParty.matchDepNames, thirdPartyDepNames);
  assert.deepEqual(majorThirdParty.matchDepNames, thirdPartyDepNames);
  assert.deepEqual(netcracker.matchPackageNames, ['Netcracker/**', 'netcracker/**']);
  for (const rule of [thirdParty, netcracker]) {
    assert.deepEqual(rule.matchUpdateTypes, nonMajorUpdateTypes);
  }
  for (const rule of [majorThirdParty, majorNetcracker]) {
    assert.deepEqual(rule.matchUpdateTypes, ['major']);
  }
}

function assertGoPolicy(config) {
  assert.equal(JSON.stringify(config).includes('gomodTidy'), false, 'go.json must not enable gomodTidy');
  for (const description of [
    'Group Kubernetes Go modules',
    'Group OpenTelemetry Go modules',
    'Group Prometheus Go modules',
    'Group Go toolchain versions',
    'Group explicit GitHub Actions Go versions with Go toolchain updates',
    'Group official Go builder images with Go toolchain updates',
  ]) {
    findRule(config, description);
  }
  assert.equal(config.packageRules.length, 6, 'go.json must not group unrelated Go dependencies');
  const kubernetes = findRule(config, 'Group Kubernetes Go modules');
  assert.deepEqual(kubernetes.matchPackageNames, [
    'k8s.io/**',
    'sigs.k8s.io/**',
    'github.com/openshift/**',
  ]);
  const openTelemetry = findRule(config, 'Group OpenTelemetry Go modules');
  assert.deepEqual(openTelemetry.matchPackageNames, [
    'go.opentelemetry.io/**',
    'github.com/open-telemetry/**',
  ]);

  const toolchain = findRule(config, 'Group Go toolchain versions');
  assert.equal(
    ruleMatchesDependency(toolchain, {
      manager: 'gomod',
      datasource: 'golang-version',
      depName: 'go',
    }),
    true,
    'go.mod Go versions must join the Go toolchain group'
  );

  const setupGoVersion = findRule(config, 'Group explicit GitHub Actions Go versions with Go toolchain updates');
  assert.equal(
    ruleMatchesDependency(setupGoVersion, {
      manager: 'github-actions',
      datasource: 'github-releases',
      depName: 'go',
      packageName: 'actions/go-versions',
    }),
    true,
    'Explicit actions/setup-go Go versions must join the Go toolchain group'
  );

  const builderImage = findRule(config, 'Group official Go builder images with Go toolchain updates');
  for (const depName of [
    'golang',
    'docker.io/library/golang',
    'index.docker.io/library/golang',
    'registry-1.docker.io/library/golang',
  ]) {
    assert.equal(
      ruleMatchesDependency(builderImage, {
        manager: 'dockerfile',
        datasource: 'docker',
        depName,
        packageName: depName,
      }),
      true,
      `The official ${depName} image must join the Go toolchain group`
    );
  }
  assert.equal(
    ruleMatchesDependency(builderImage, {
      manager: 'dockerfile',
      datasource: 'docker',
      depName: 'alpine',
    }),
    false,
    'Unrelated Docker images must stay outside the Go toolchain group'
  );
}

function assertGoTidyPolicy(config) {
  const rule = findRule(config, 'Run go mod tidy after Go module updates');
  assert.deepEqual(rule.matchManagers, ['gomod']);
  assert.deepEqual(rule.postUpdateOptions, ['gomodTidy']);
}

function assertGoCatchAllPolicy(config) {
  const rule = findRule(config, 'Group other Go module minor and patch updates');
  assert.deepEqual(rule.matchManagers, ['gomod']);
  assert.deepEqual(rule.matchDatasources, ['go']);
  assert.deepEqual(rule.matchUpdateTypes, ['minor', 'patch']);
  assert.deepEqual(rule.matchPackageNames, [
    '!k8s.io/**',
    '!sigs.k8s.io/**',
    '!github.com/openshift/**',
    '!go.opentelemetry.io/**',
    '!github.com/open-telemetry/**',
    '!github.com/prometheus/**',
    '!github.com/Netcracker/**',
  ]);
  assert.equal(rule.groupName, 'Other Go modules');

  assert.equal(
    ruleMatchesDependency(rule, {
      manager: 'gomod',
      datasource: 'go',
      packageName: 'github.com/stretchr/testify',
      updateType: 'minor',
    }),
    true,
    'Unrelated Go module minor updates must join the catch-all group'
  );
  for (const packageName of [
    'k8s.io/client-go',
    'go.opentelemetry.io/otel',
    'github.com/prometheus/client_golang',
    'github.com/Netcracker/qubership-core-lib-go',
  ]) {
    assert.equal(
      ruleMatchesDependency(rule, {
        manager: 'gomod',
        datasource: 'go',
        packageName,
        updateType: 'minor',
      }),
      false,
      `${packageName} must retain its capability-preset group`
    );
  }
  assert.equal(
    ruleMatchesDependency(rule, {
      manager: 'gomod',
      datasource: 'go',
      packageName: 'github.com/stretchr/testify',
      updateType: 'major',
    }),
    false,
    'Major updates must remain separate from the catch-all group'
  );
}

function assertNetcrackerPolicy(config) {
  const expected = [
    ['Group Netcracker GitHub Actions', 'matchManagers', ['github-actions']],
    ['Group Netcracker Docker images', 'matchDatasources', ['docker']],
    ['Group Netcracker Go modules', 'matchManagers', ['gomod']],
    ['Group Netcracker Maven artifacts', 'matchManagers', ['maven']],
  ];
  for (const [description, matcher, values] of expected) {
    const rule = findRule(config, description);
    assert.deepEqual(rule[matcher], values);
    assert.equal(rule.minimumReleaseAge, '0 days');
    assert.ok(rule.groupName);
  }
  assert.deepEqual(findRule(config, 'Group Netcracker GitHub Actions').matchUpdateTypes, [
    'minor',
    'patch',
    'pin',
    'digest',
    'pinDigest',
  ]);
  const majorActions = findRule(config, 'Group major Netcracker GitHub Actions updates separately');
  assert.deepEqual(majorActions.matchUpdateTypes, ['major']);
  assert.equal(majorActions.minimumReleaseAge, '0 days');
}

function assertMavenGroupIdPolicy(config, netcrackerConfig) {
  const defaultRule = findRule(config, 'Group Maven updates by groupId');
  assert.deepEqual(defaultRule.matchDatasources, ['maven']);

  const junitApi = render(defaultRule.groupName, {
    datasource: 'maven',
    depName: 'org.junit.jupiter:junit-jupiter-api',
  });
  const junitEngine = render(defaultRule.groupName, {
    datasource: 'maven',
    depName: 'org.junit.jupiter:junit-jupiter-engine',
  });
  assert.equal(junitApi, 'org.junit.jupiter');
  assert.equal(junitEngine, junitApi, 'Maven artifacts with the same groupId must share a group');
  assert.notEqual(
    render(defaultRule.groupName, {
      datasource: 'maven',
      depName: 'org.junit.platform:junit-platform-launcher',
    }),
    junitApi,
    'Different Maven groupIds must stay in separate groups'
  );

  const vulnerabilityGroup = config.vulnerabilityAlerts?.groupName;
  assert.ok(vulnerabilityGroup, 'Maven vulnerability updates must define a group');
  assert.equal(
    render(vulnerabilityGroup, {
      datasource: 'maven',
      depName: 'org.apache.logging.log4j:log4j-core',
    }),
    'org.apache.logging.log4j security'
  );
  assert.notEqual(
    render(vulnerabilityGroup, {
      datasource: 'docker',
      depName: 'ghcr.io/netcracker/example',
    }),
    render(vulnerabilityGroup, {
      datasource: 'go',
      depName: 'ghcr.io/netcracker/example',
    }),
    'Non-Maven vulnerability groups must remain distinct across datasources'
  );

  const internalDependency = {
    manager: 'maven',
    datasource: 'maven',
    depName: 'org.qubership.profiler:agent',
    packageName: 'org.qubership.profiler:agent',
  };
  const internalRule = findRule(netcrackerConfig, 'Group Netcracker Maven artifacts');
  const result = applyPackageRules(internalDependency, [defaultRule, internalRule]);
  assert.equal(result.groupName, 'Netcracker Maven artifacts');
  assert.equal(
    render(vulnerabilityGroup, internalDependency),
    'org.qubership.profiler security',
    'Vulnerability updates must use the Maven groupId even for internal artifacts'
  );
}

function assertNoAutomerge(configs) {
  for (const [name, config] of Object.entries(configs)) {
    assert.equal('automerge' in config, false, `${name}.json must not configure automerge`);
    for (const rule of config.packageRules ?? []) {
      assert.equal('automerge' in rule, false, `${name}.json package rules must not configure automerge`);
    }
  }
}

function assertRepositoryPolicy(config) {
  assert.ok(
    config.extends?.includes(':ignoreModulesAndTests'),
    'renovate.json must ignore test and fixture dependency files'
  );
}

function assertOrgInheritedPolicy(config) {
  const profanityFilterAction = {
    manager: 'github-actions',
    datasource: 'github-tags',
    packageName: 'IEvangelist/profanity-filter',
    currentValue: 'v13.4.6',
  };
  assert.equal(
    applyPackageRules(profanityFilterAction, config.packageRules).enabled,
    false,
    'The known broken extracted Action version must be disabled'
  );
  assert.equal(
    applyPackageRules({ ...profanityFilterAction, currentValue: '13.4.6' }, config.packageRules).enabled,
    false,
    'The broken version without a v prefix must also be disabled'
  );
  assert.equal(
    applyPackageRules({ ...profanityFilterAction, currentValue: 'v13.4.7' }, config.packageRules).enabled,
    undefined,
    'Other versions of the same Action must remain enabled'
  );
  assert.equal(
    applyPackageRules(
      { ...profanityFilterAction, packageName: 'actions/checkout' },
      config.packageRules
    ).enabled,
    undefined,
    'Other GitHub Actions must remain enabled'
  );
  assert.equal(
    applyPackageRules(
      { ...profanityFilterAction, manager: 'custom.regex' },
      config.packageRules
    ).enabled,
    undefined,
    'The exception must apply only to the GitHub Actions manager'
  );
  const projectOverride = {
    matchManagers: ['github-actions'],
    matchPackageNames: ['IEvangelist/profanity-filter'],
    enabled: true,
  };
  assert.equal(
    applyPackageRules(profanityFilterAction, [...config.packageRules, projectOverride]).enabled,
    true,
    'A later repository rule must be able to re-enable the Action after a compatible release is available'
  );

  // Renovate normalizes "0 days" to null before applying package rules. Keep the pinDigest rule last so this
  // raw-rule merger also verifies policy precedence and catches a future inherited rule that restores the delay.
  for (const packageName of ['alpine', 'ghcr.io/netcracker/example']) {
    const pinDigest = applyPackageRules(
      {
        manager: 'dockerfile',
        datasource: 'docker',
        packageName,
        updateType: 'pinDigest',
      },
      config.packageRules
    );
    assert.equal(
      pinDigest.minimumReleaseAge,
      null,
      `Pinning ${packageName} must not wait for a release timestamp`
    );
  }

  const versionPin = applyPackageRules(
    {
      manager: 'npm',
      datasource: 'npm',
      packageName: 'example-package',
      updateType: 'pin',
    },
    config.packageRules
  );
  assert.equal(
    versionPin.minimumReleaseAgeBehaviour,
    'timestamp-optional',
    'Version pins must proceed when Renovate cannot attach a release timestamp'
  );

  const dockerDigest = applyPackageRules(
    {
      manager: 'dockerfile',
      datasource: 'docker',
      packageName: 'alpine',
      updateType: 'digest',
    },
    config.packageRules
  );
  assert.equal(
    dockerDigest.minimumReleaseAgeBehaviour,
    'timestamp-optional',
    'Docker digest updates must proceed when their registry does not provide a release timestamp'
  );

  for (const dependency of [
    {
      manager: 'npm',
      datasource: 'npm',
      packageName: 'example-package',
      updateType: 'patch',
    },
    {
      manager: 'gomod',
      datasource: 'go',
      packageName: 'example.com/module',
      updateType: 'digest',
    },
  ]) {
    const result = applyPackageRules(dependency, config.packageRules);
    assert.equal(
      result.minimumReleaseAgeBehaviour,
      undefined,
      `${dependency.datasource} ${dependency.updateType} updates must retain the timestamp-required default`
    );
  }
}

function assertAnnotatedVersions(config) {
  const annotatedManagers = config.customManagers.filter(
    (manager) => manager.depTypeTemplate === 'annotated-version'
  );
  assert.equal(annotatedManagers.length, 7, 'All version-only annotation managers must be covered');
  for (const manager of annotatedManagers) {
    assert.equal(
      manager.depTypeTemplate,
      'annotated-version',
      `${manager.description} must identify version-only dependencies`
    );
  }

  const digestPinning = findRule(config, 'Disable digest pinning for version-only Docker annotations');
  assert.deepEqual(digestPinning.matchManagers, ['custom.regex']);
  assert.deepEqual(digestPinning.matchDatasources, ['docker']);
  assert.deepEqual(digestPinning.matchDepTypes, ['annotated-version']);
  assert.equal(digestPinning.pinDigests, false);

  const versionOnlyDockerAnnotation = {
    manager: 'custom.regex',
    datasource: 'docker',
    depName: 'graylog/graylog',
    depType: 'annotated-version',
  };
  assert.equal(
    ruleMatchesDependency(digestPinning, versionOnlyDockerAnnotation),
    true,
    'Version-only Docker annotations must match the digest override'
  );

  const inheritedDigestPinning = {
    matchDatasources: ['docker'],
    pinDigests: true,
  };
  assert.equal(
    applyPackageRules(versionOnlyDockerAnnotation, [inheritedDigestPinning, ...config.packageRules]).pinDigests,
    false,
    'annotated-versions must override the base Docker digest policy when it is extended after base'
  );
  assert.equal(
    applyPackageRules(versionOnlyDockerAnnotation, [...config.packageRules, inheritedDigestPinning]).pinDigests,
    true,
    'A later base Docker digest policy must override annotated-versions'
  );

  for (const testCase of [
    {
      manager: 'custom.regex',
      datasource: 'docker',
      depName: 'alpine',
      depType: 'alpine-release-sync',
      expectedPinDigests: false,
    },
    {
      manager: 'dockerfile',
      datasource: 'docker',
      depName: 'alpine',
      depType: 'final',
      expectedPinDigests: true,
    },
    {
      manager: 'helm-values',
      datasource: 'docker',
      depName: 'graylog/graylog',
      depType: 'docker',
      expectedPinDigests: true,
    },
    {
      manager: 'custom.regex',
      datasource: 'docker',
      depName: 'Netcracker/example',
      depType: 'annotated-docker-image',
      expectedPinDigests: true,
    },
    {
      manager: 'custom.regex',
      datasource: 'github-releases',
      depName: 'Netcracker/example',
      depType: 'annotated-version',
      expectedPinDigests: undefined,
    },
  ]) {
    const { expectedPinDigests, ...dependency } = testCase;
    assert.equal(
      ruleMatchesDependency(digestPinning, dependency),
      false,
      `${dependency.manager}/${dependency.datasource}/${dependency.depType} must retain the inherited digest policy`
    );
    assert.equal(
      applyPackageRules(dependency, [inheritedDigestPinning, ...config.packageRules]).pinDigests,
      expectedPinDigests,
      `${dependency.manager}/${dependency.datasource}/${dependency.depType} must keep its inherited policy value`
    );
  }

  const fixtures = [
    [
      'annotated-versions/Dockerfile',
      'Update annotated Docker ARG version values.',
      'alpine',
      '3.22.0',
      undefined,
      undefined,
    ],
    [
      'annotated-versions/values.yaml',
      'Update annotated next-line YAML and template version values.',
      'prometheus/prometheus',
      'v3.5.0',
      undefined,
      undefined,
    ],
    [
      'annotated-versions/config.yaml.tmpl',
      'Update annotated next-line YAML and template version values.',
      'ghcr.io/netcracker/example',
      '1.2.3',
      'ghcr.io/netcracker/example',
      'docker',
    ],
    [
      'annotated-versions/Makefile',
      'Update annotated go install versions in Makefiles.',
      'golang.org/x/tools/gopls',
      'v0.19.1',
      undefined,
      'semver',
    ],
    [
      'annotated-versions/variables.mk',
      'Update annotated version variables in Makefiles and environment files.',
      'sigs.k8s.io/controller-tools',
      'v0.20.0',
      undefined,
      'semver',
    ],
    [
      'annotated-versions/kind.env',
      'Update annotated version variables in Makefiles and environment files.',
      'Netcracker/qubership-opensearch',
      '2.3.0',
      undefined,
      'semver',
    ],
    [
      'annotated-versions/monitoring/templates/grafana-image.tpl',
      'Update annotated image versions in Helm print templates.',
      'quay.io/grafana-operator/grafana-operator',
      'v5.22.2',
      undefined,
      undefined,
    ],
    [
      'annotated-versions/helm-comment.tpl',
      'Update annotated image versions in Helm print templates.',
      'otel/opentelemetry-collector-contrib',
      '0.131.0',
      undefined,
      undefined,
    ],
    [
      'annotated-versions/logging/templates/graylog-image.tpl',
      'Update annotated image versions in Helm print templates.',
      'graylog/graylog',
      '5.2.12',
      undefined,
      undefined,
    ],
    [
      'annotated-versions/logging/values.yaml',
      'Update annotated commented image versions in YAML files.',
      'Netcracker/qubership-fluentd',
      '1.19.2-2',
      undefined,
      'loose',
    ],
    [
      'annotated-versions/logging/fluent.conf',
      'Update annotated version directives in configuration files.',
      'Netcracker/qubership-fluentd',
      '1.19.2-2',
      undefined,
      'loose',
    ],
  ];
  for (const [path, managerDescription, depName, currentValue, packageName, versioning] of fixtures) {
    const matchingManagers = config.customManagers.filter((manager) => managerMatchesPath(manager, path));
    const matches = matchingManagers.flatMap((manager) =>
      extract(manager, readFixture(path)).map((dependency) => ({ dependency, manager }))
    );
    assert.equal(matches.length, 1, `${path} must contain exactly one annotated dependency`);
    assert.equal(matches[0].manager.description, managerDescription, `${path} matched the wrong custom manager`);
    assert.equal(matches[0].dependency.depName, depName);
    assert.equal(matches[0].dependency.currentValue, currentValue);
    assert.equal(matches[0].dependency.packageName, packageName);
    assert.equal(matches[0].dependency.versioning, versioning);
  }

  const overlappingPath = 'annotated-versions/.env.mk';
  const overlappingContent =
    '# renovate: datasource=github-releases depName=Netcracker/example versioning=semver\nVERSION=1.2.3\n';
  const overlappingMatches = config.customManagers
    .filter((manager) => managerMatchesPath(manager, overlappingPath))
    .flatMap((manager) => extract(manager, overlappingContent));
  assert.equal(overlappingMatches.length, 1, `${overlappingPath} must be handled by only one custom manager`);

  const hiddenMakePath = 'annotated-versions/.tools.mk';
  const hiddenMakeContent =
    '# renovate: datasource=go depName=sigs.k8s.io/controller-tools versioning=semver\n' +
    'go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.19.1\n';
  const hiddenMakeMatches = config.customManagers
    .filter((manager) => managerMatchesPath(manager, hiddenMakePath))
    .flatMap((manager) => extract(manager, hiddenMakeContent));
  assert.equal(hiddenMakeMatches.length, 1, `${hiddenMakePath} must preserve hidden Makefile support`);

  const digestManagerDescription = 'Update digest-pinned images in Helm print templates.';
  const digestManager = config.customManagers.find(
    (manager) => manager.description === digestManagerDescription
  );
  assert.ok(digestManager, `Custom manager not found: ${digestManagerDescription}`);
  assert.equal(digestManager.depTypeTemplate, 'annotated-docker-image');

  const digestFixturePath =
    'annotated-versions/logging/templates/graylog-image-digest.tpl';
  const digestFixture = readFixture(digestFixturePath);
  const digestMatches = config.customManagers
    .filter((manager) => managerMatchesPath(manager, digestFixturePath))
    .flatMap((manager) =>
      extract(manager, digestFixture).map((dependency) => ({ dependency, manager }))
    );
  assert.equal(digestMatches.length, 1, `${digestFixturePath} must contain exactly one annotated dependency`);
  assert.equal(digestMatches[0].manager.description, digestManagerDescription);
  assert.deepEqual(
    {
      depName: digestMatches[0].dependency.depName,
      datasource: digestMatches[0].dependency.datasource,
      currentValue: digestMatches[0].dependency.currentValue,
      currentDigest: digestMatches[0].dependency.currentDigest,
    },
    {
      depName: 'graylog/graylog',
      datasource: 'docker',
      currentValue: '5.2.12',
      currentDigest:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }
  );

  const updatedDigestFixture = replaceRegexDependency(
    digestManager,
    digestFixture,
    0,
    '5.2.13',
    'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  );
  const updatedDigestDependencies = extract(digestManager, updatedDigestFixture);
  assert.equal(updatedDigestDependencies.length, 1);
  assert.equal(updatedDigestDependencies[0].currentValue, '5.2.13');
  assert.equal(
    updatedDigestDependencies[0].currentDigest,
    'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  );
  assert.match(
    updatedDigestFixture,
    /graylog\/graylog:5\.2\.13@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789/
  );

  const digestOnlyFixture = replaceRegexDependency(
    digestManager,
    digestFixture,
    0,
    '5.2.12',
    'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
  );
  const digestOnlyDependencies = extract(digestManager, digestOnlyFixture);
  assert.equal(digestOnlyDependencies.length, 1);
  assert.equal(digestOnlyDependencies[0].currentValue, '5.2.12');
  assert.equal(
    digestOnlyDependencies[0].currentDigest,
    'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
  );

  for (const currentValue of ['3.24', '1', 'jammy', 'latest']) {
    const content =
      '{{- /* # renovate: datasource=docker depName=alpine */ -}}\n' +
      `{{- print "docker.io/alpine:${currentValue}@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" -}}\n`;
    const dependencies = extract(digestManager, content);
    assert.equal(dependencies.length, 1, `Docker tag ${currentValue} must be extracted`);
    assert.equal(dependencies[0].currentValue, currentValue);
  }
}

function assertAlpineRepologySync(config) {
  const managerDescription = 'Keep Alpine Repology repositories in sync with the Alpine image.';
  const manager = config.customManagers.find((candidate) => candidate.description === managerDescription);
  assert.ok(manager, `Custom manager not found: ${managerDescription}`);

  const fixture = readFixture('annotated-versions/Dockerfile.alpine-sync');
  const dependencies = extract(manager, fixture);
  const argManager = config.customManagers.find(
    (candidate) => candidate.description === 'Update annotated Docker ARG version values.'
  );
  const packageDependencies = extract(argManager, fixture);

  assert.equal(managerMatchesPath(manager, 'Dockerfile'), true);
  assert.equal(managerMatchesPath(manager, 'containers/Containerfile.runtime'), true);
  assert.equal(managerMatchesPath(manager, 'containers/image.yaml'), false);
  assert.equal(manager.datasourceTemplate, 'docker');
  assert.equal('depNameTemplate' in manager, false);
  assert.equal(manager.packageNameTemplate, 'alpine');
  assert.equal(manager.versioningTemplate, 'docker');
  assert.equal(manager.depTypeTemplate, 'alpine-release-sync');
  assert.equal(manager.currentValueTemplate, "{{{ replace '_' '.' currentValue }}}");
  assert.equal(dependencies.length, 1, 'Only annotations marked with syncWith=alpine must be synchronized');
  assert.deepEqual(
    packageDependencies.map(({ depName, currentValue }) => [depName, currentValue]),
    [
      ['alpine_3_22/build-base', '0.5-r3'],
      ['alpine_3_23/busybox', '1.37.0-r31'],
    ],
    'The sync marker must not hide the APK package dependency'
  );
  assert.deepEqual(
    {
      currentValue: dependencies[0].currentValue,
      depName: dependencies[0].depName,
    },
    {
      currentValue: '3_23',
      depName: 'busybox',
    }
  );

  const runtimeDependencies = extractRuntimeDependencies(manager, fixture);
  assert.equal(runtimeDependencies.length, 1);
  assert.deepEqual(runtimeDependencies[0], {
    depName: 'busybox',
    packageName: 'alpine',
    currentValue: '3.23',
    datasource: 'docker',
    versioning: 'docker',
    depType: 'alpine-release-sync',
    replaceString:
      '# renovate: datasource=repology depName=alpine_3_23/busybox versioning=apk syncWith=alpine',
  });
  const runtimeReplacement = render(manager.autoReplaceStringTemplate, {
    ...runtimeDependencies[0],
    newMajor: '3',
    newMinor: '25',
  });
  assert.equal(
    runtimeReplacement,
    '# renovate: datasource=repology depName=alpine_3_25/busybox versioning=apk syncWith=alpine',
    'Alpine synchronization must preserve the APK package name after extraction'
  );
  const updatedRuntimeDependencies = extractRuntimeDependencies(manager, runtimeReplacement);
  assert.equal(
    updatedRuntimeDependencies.length,
    1,
    'Renovate must extract the annotation again after autoreplace'
  );
  assert.equal(updatedRuntimeDependencies[0].currentValue, '3.25');
  assert.equal(updatedRuntimeDependencies[0].depName, 'busybox');

  const rule = findRule(config, 'Group Alpine image and synchronized Repology repository updates');
  assert.deepEqual(rule.matchDatasources, ['docker']);
  assert.deepEqual(rule.matchPackageNames, ['alpine']);
  assert.equal(rule.groupName, 'alpine-release');

  const digestPinning = findRule(config, 'Disable digest pinning for Alpine repository synchronization');
  assert.deepEqual(digestPinning.matchDepTypes, ['alpine-release-sync']);
  assert.equal(digestPinning.pinDigests, false);

  const repologyReleaseAge = findRule(config, 'Bypass release age for Alpine Repology packages');
  assert.deepEqual(repologyReleaseAge.matchDatasources, ['repology']);
  assert.deepEqual(repologyReleaseAge.matchPackageNames, ['/^alpine_\\d+_\\d+\\/.+$/']);
  assert.equal(repologyReleaseAge.minimumReleaseAge, '0 days');
}

function assertTestPipelines(config) {
  const manager = config.customManagers[0];
  const fixture = readFixture('test-pipelines/workflows.yaml');
  const dependencies = extract(manager, fixture);

  assert.equal(managerMatchesPath(manager, '.github/workflows/integration-tests.yaml'), true);
  assert.equal(managerMatchesPath(manager, '.github/workflows/run_tests.yml'), true);
  assert.equal(managerMatchesPath(manager, 'docs/workflows.yaml'), false);
  assert.equal(manager.datasourceTemplate, 'github-tags');

  assert.deepEqual(
    dependencies.map(({ depName, currentValue, currentDigest }) => [depName, currentValue, currentDigest]),
    [
      [
        'Netcracker/qubership-test-pipelines',
        'v1.14.1',
        'ddc741b38bac5dc4834b8f6827c9f6d16abf0db8',
      ],
      [
        'Netcracker/qubership-test-pipelines',
        'v1.8.0',
        '247c69038e00f2a9e283412e902555f84b16dab2',
      ],
      ['Netcracker/qubership-test-pipelines', 'v2', 'abcdef0'],
    ]
  );

  const replacement = replaceRegexDependency(
    manager,
    fixture,
    0,
    'v1.15.0',
    '0123456789abcdef0123456789abcdef01234567'
  );
  const updated = extract(manager, replacement);

  assert.equal(updated.length, dependencies.length);
  assert.equal(updated[0].currentValue, 'v1.15.0');
  assert.equal(updated[0].currentDigest, '0123456789abcdef0123456789abcdef01234567');
  assert.match(
    replacement,
    /pipeline_branch: '0123456789abcdef0123456789abcdef01234567' # v1\.15\.0 renovate: depName=Netcracker\/qubership-test-pipelines/
  );
}

function assertGrafanaPlugins(config) {
  const manager = config.customManagers[0];
  const dependencies = extract(manager, readFixture('grafana-plugins/plugins.list'));
  assert.deepEqual(
    dependencies.map(({ depName, currentValue }) => [depName, currentValue]),
    [
      ['retrodaredevil-wildgraphql-datasource', '1.6.1'],
      ['victoriametrics-metrics-datasource', '0.25.1'],
    ]
  );
  assert.ok(config.customDatasources?.['grafana-plugins']);
  assert.equal(manager.datasourceTemplate, 'custom.grafana-plugins');
  assert.deepEqual(config.customDatasources['grafana-plugins'].transformTemplates, [
    '{"releases": [items.{"version": version, "releaseTimestamp": createdAt}]}',
  ]);
}

function assertGraylogPlugins(config) {
  const manager = config.customManagers[0];
  assert.equal(manager.depTypeTemplate, 'graylog-plugin');
  assert.deepEqual(findRule(config, 'Group Graylog plugin updates').matchDepTypes, ['graylog-plugin']);
  const fixture = readFixture('graylog-plugins/plugins.list');
  const dependencies = extract(manager, fixture);
  assert.equal(dependencies.length, 2);
  assert.deepEqual(
    dependencies.map(({ packageName, currentValue }) => [packageName, currentValue]),
    [
      ['graylog-labs/graylog-plugin-metrics-reporter', '3.0.0'],
      ['irgendwr/TelegramAlert', 'v2.3.7'],
    ]
  );

  const updates = ['4.0.0', 'v2.4.0'];
  for (const [index, groups] of dependencies.entries()) {
    const newValue = updates[index];
    const replacement = render(manager.autoReplaceStringTemplate, { ...groups, newValue });
    assert.ok(replacement.includes(`/download/${newValue}/`));
    assert.ok(replacement.endsWith(`-${newValue.replace(/^v/, '')}.jar`));
  }
}

const configs = Object.fromEntries(presetNames.map((name) => [name, readJson(`${name}.json`)]));
assertRepositoryPolicy(readJson('renovate.json'));
assertOrgInheritedPolicy(readJson('org-inherited-config.json'));
assertBasePolicy(configs.base);
assertGitHubActionsPolicy(configs['github-actions']);
assertGoPolicy(configs.go);
assertGoCatchAllPolicy(configs['go-catch-all']);
assertGoTidyPolicy(configs['go-tidy']);
assertMavenGroupIdPolicy(configs['maven-groupid'], configs['netcracker-dependencies']);
assertNetcrackerPolicy(configs['netcracker-dependencies']);
assertTestPipelines(configs['test-pipelines']);
assertAnnotatedVersions(configs['annotated-versions']);
assertAlpineRepologySync(configs['annotated-versions']);
assertGrafanaPlugins(configs['grafana-plugins']);
assertGraylogPlugins(configs['graylog-plugins']);
assertNoAutomerge(configs);

console.log(`Validated ${presetNames.length} capability presets and their extraction fixtures.`);
