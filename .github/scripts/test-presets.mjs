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
  const newValueMatches = !rule.matchNewValue || matchesStringPatterns([rule.matchNewValue], dependency.newValue);
  return arrayMatchersMatch && currentValueMatches && newValueMatches;
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
  assert.equal(
    config.extends,
    undefined,
    'base.json must not extend config:recommended or config:best-practices again, which would apply the built-in rules after the inherited ones'
  );
  assert.deepEqual(config.schedule, ['at any time'], 'base.json must not hold back PR creation to a weekly window');
  assert.equal(config.prConcurrentLimit, 10, 'base.json must cap the number of open PRs');
  assert.equal(config.prHourlyLimit, 5, 'base.json must spread a burst of new PRs over a few hours');
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
  const thirdPartyPackageNames = [
    '!Netcracker/**',
    '!netcracker/**',
    '!renovate/renovate',
    '!ghcr.io/renovatebot/renovate',
  ];
  assert.deepEqual(thirdParty.matchPackageNames, thirdPartyPackageNames);
  assert.deepEqual(majorThirdParty.matchPackageNames, thirdPartyPackageNames);
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
  assert.deepEqual(
    config.extends,
    ['github>Netcracker/renovate-config:go-tidy'],
    'go.json must enable go-tidy on the minimum supported Renovate version'
  );
  for (const description of [
    'Group Kubernetes Go modules',
    'Group OpenTelemetry Go modules',
    'Group Prometheus Go modules',
    'Group Go toolchain versions',
    'Keep the go directive in go.mod out of the Go toolchain group',
    'Group explicit GitHub Actions Go versions with Go toolchain updates',
    'Group official Go builder images with Go toolchain updates',
  ]) {
    findRule(config, description);
  }
  assert.equal(config.packageRules.length, 7, 'go.json must not group unrelated Go dependencies');
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

  const goModGoVersion = { manager: 'gomod', datasource: 'golang-version', depName: 'go' };
  assert.equal(
    applyPackageRules({ ...goModGoVersion, depType: 'toolchain' }, config.packageRules).groupName,
    'Go toolchain',
    'The go.mod toolchain directive must join the Go toolchain group'
  );
  assert.equal(
    applyPackageRules({ ...goModGoVersion, depType: 'golang' }, config.packageRules).groupName,
    'Go directive',
    'The go.mod go directive must stay out of the Go toolchain group'
  );
  assert.equal(
    applyPackageRules({ manager: 'mise', datasource: 'golang-version', depName: 'go' }, config.packageRules).groupName,
    'Go toolchain',
    'Go versions outside go.mod must join the Go toolchain group'
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
    'library/golang',
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
  // Renovate runs go mod tidy on a major update only when gomodUpdateImportPaths is set (artifacts.ts in
  // lib/modules/manager/gomod), so without it a major PR leaves the code importing the old major.
  assert.deepEqual(rule.postUpdateOptions, ['gomodTidy', 'gomodUpdateImportPaths']);
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
  const byteBuddy = {
    manager: 'maven',
    datasource: 'maven',
    packageName: 'net.bytebuddy:byte-buddy',
    currentValue: '1.18.15',
  };
  assert.equal(
    applyPackageRules(byteBuddy, config.packageRules).allowedVersions,
    '!/-jdk5$/',
    'Byte Buddy on the regular build must not be offered the -jdk5 build'
  );
  assert.equal(
    applyPackageRules({ ...byteBuddy, packageName: 'net.bytebuddy:byte-buddy-agent' }, config.packageRules)
      .allowedVersions,
    '!/-jdk5$/',
    'The rule must cover every net.bytebuddy artifact'
  );
  assert.equal(
    applyPackageRules({ ...byteBuddy, currentValue: '1.18.15-jdk5' }, config.packageRules).allowedVersions,
    undefined,
    'Byte Buddy already on the -jdk5 build must keep receiving -jdk5 updates'
  );
  assert.equal(
    applyPackageRules({ ...byteBuddy, packageName: 'org.ow2.asm:asm' }, config.packageRules).allowedVersions,
    undefined,
    'Other Maven packages must not be restricted'
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

  const dockerDigestRule = findRule(config, 'Allow Docker digest updates when the registry does not provide');
  assert.deepEqual(dockerDigestRule.matchDatasources, ['docker']);
  assert.deepEqual(dockerDigestRule.matchUpdateTypes, ['digest']);
  assert.equal(dockerDigestRule.minimumReleaseAgeBehaviour, 'timestamp-optional');

  const githubActionsDigestRule = findRule(
    config,
    'Allow GitHub tag digest updates when the datasource does not report a release timestamp'
  );
  assert.equal('matchManagers' in githubActionsDigestRule, false);
  assert.deepEqual(githubActionsDigestRule.matchDatasources, ['github-tags']);
  assert.deepEqual(githubActionsDigestRule.matchUpdateTypes, ['digest']);
  assert.equal(githubActionsDigestRule.minimumReleaseAgeBehaviour, 'timestamp-optional');

  for (const dependency of [
    {
      manager: 'dockerfile',
      datasource: 'docker',
      packageName: 'alpine',
      updateType: 'digest',
    },
    {
      manager: 'github-actions',
      datasource: 'github-tags',
      packageName: 'docker/login-action',
      updateType: 'digest',
    },
    {
      manager: 'custom.regex',
      datasource: 'github-tags',
      packageName: 'example/third-party-package',
      updateType: 'digest',
    },
  ]) {
    const digest = applyPackageRules(
      { ...dependency, minimumReleaseAge: config.minimumReleaseAge },
      config.packageRules
    );
    assert.equal(
      digest.minimumReleaseAgeBehaviour,
      'timestamp-optional',
      `${dependency.datasource} digest updates must proceed when no release timestamp is available`
    );
    assert.equal(
      digest.minimumReleaseAge,
      '7 days',
      `${dependency.datasource} digest updates with a release timestamp must retain the seven-day delay`
    );
  }

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
    {
      manager: 'github-actions',
      datasource: 'github-tags',
      packageName: 'docker/login-action',
      updateType: 'patch',
    },
    {
      manager: 'github-actions',
      datasource: 'github-digest',
      packageName: 'docker/login-action',
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

  const goDirective = { manager: 'gomod', datasource: 'golang-version', depName: 'go', depType: 'golang' };
  for (const updateType of ['patch', 'minor', 'major']) {
    const goDirectiveResult = applyPackageRules({ ...goDirective, updateType }, config.packageRules);
    assert.equal(
      goDirectiveResult.minimumReleaseAge,
      '1095 days',
      `A ${updateType} update of the go directive must wait until the Go release is three years old`
    );
    assert.equal(goDirectiveResult.rangeStrategy, 'bump', 'The go directive must be bumped, not left as a range');
  }

  for (const dependency of [
    { ...goDirective, depType: 'toolchain' },
    { manager: 'mise', datasource: 'golang-version', depName: 'go' },
  ]) {
    const patch = applyPackageRules({ ...dependency, updateType: 'patch' }, config.packageRules);
    assert.equal(
      patch.minimumReleaseAge,
      '0 days',
      `A ${dependency.manager} Go patch update must not wait, since Go ships security fixes in patch releases`
    );
    assert.equal(patch.rangeStrategy, undefined, `The ${dependency.manager} Go version must keep the default strategy`);

    for (const updateType of ['minor', 'major']) {
      const result = applyPackageRules({ ...dependency, updateType }, config.packageRules);
      assert.equal(
        result.minimumReleaseAge,
        '90 days',
        `A ${dependency.manager} Go ${updateType} update must wait until linters built with an older Go catch up`
      );
    }
  }

  // The rule carries no matchManagers, so a builder image reaches it from a Dockerfile, a workflow container:, and a
  // custom.regex dependency alike.
  const builderImageTag = '1.27.2-alpine3.24';
  for (const packageName of [
    'golang',
    'library/golang',
    'docker.io/library/golang',
    'index.docker.io/library/golang',
    'registry-1.docker.io/library/golang',
  ]) {
    for (const manager of ['dockerfile', 'github-actions', 'custom.regex']) {
      for (const updateType of ['patch', 'digest']) {
        const result = applyPackageRules(
          {
            manager,
            datasource: 'docker',
            packageName,
            currentValue: builderImageTag,
            updateType,
            minimumReleaseAge: config.minimumReleaseAge,
          },
          config.packageRules
        );
        assert.equal(
          result.minimumReleaseAge,
          '0 days',
          `A ${updateType} update of ${packageName}:${builderImageTag} in a ${manager} file must not wait, since Go ships security fixes in patch releases`
        );
      }
    }

    for (const updateType of ['minor', 'major']) {
      const result = applyPackageRules(
        {
          manager: 'dockerfile',
          datasource: 'docker',
          packageName,
          currentValue: builderImageTag,
          updateType,
          minimumReleaseAge: config.minimumReleaseAge,
        },
        config.packageRules
      );
      assert.equal(
        result.minimumReleaseAge,
        '7 days',
        `A ${updateType} update of ${packageName}:${builderImageTag} must keep the standard delay`
      );
    }
  }

  // config:best-practices pins Docker digests, so a tag that does not name the Go minor release keeps its text when
  // upstream rebuilds it on the next minor release, and that jump reaches Renovate as a digest update.
  for (const currentValue of ['alpine', 'latest', '1', '1-alpine3.24', 'bookworm']) {
    const floatingTag = applyPackageRules(
      {
        manager: 'dockerfile',
        datasource: 'docker',
        packageName: 'golang',
        currentValue,
        updateType: 'digest',
        minimumReleaseAge: config.minimumReleaseAge,
      },
      config.packageRules
    );
    assert.equal(
      floatingTag.minimumReleaseAge,
      '7 days',
      `A digest update of golang:${currentValue} must keep the standard delay, since the tag does not pin the Go minor release`
    );
  }

  for (const packageName of ['node', 'golangci/golangci-lint', 'ghcr.io/example/golang']) {
    for (const updateType of ['patch', 'digest']) {
      const otherImage = applyPackageRules(
        {
          manager: 'dockerfile',
          datasource: 'docker',
          packageName,
          currentValue: builderImageTag,
          updateType,
          minimumReleaseAge: config.minimumReleaseAge,
        },
        config.packageRules
      );
      assert.equal(
        otherImage.minimumReleaseAge,
        '7 days',
        `A ${updateType} update of ${packageName} must keep the standard delay, since it is not the official golang image`
      );
    }
  }
}

// Mirrors RegExpVersioningApi._parse in renovatebot/renovate lib/modules/versioning/regex/index.ts: a missing
// major, minor, or patch counts as 0, and build and revision extend the release only when present.
function parseRegexVersion(versioning, version) {
  const groups = new RegExp(versioning.slice('regex:'.length)).exec(version)?.groups;
  if (!groups) {
    return null;
  }
  const release = [groups.major, groups.minor, groups.patch].map((part) => (part === undefined ? 0 : Number(part)));
  if (groups.build) {
    release.push(Number(groups.build));
    if (groups.revision) {
      release.push(Number(groups.revision));
    }
  }
  return { release, compatibility: groups.compatibility };
}

function compareReleases(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

// Picks the tag Renovate would propose among the published ones: a tag the versioning parses, that allowedVersions
// admits, with the same compatibility suffix as the current tag, and the highest release.
function newestCompatibleTag(config, currentValue, publishedTags, packageName = 'nginx') {
  const { versioning, allowedVersions } = applyPackageRules(
    { manager: 'dockerfile', datasource: 'docker', packageName, currentValue },
    config.packageRules
  );
  assert.match(allowedVersions ?? '/.*/', /^\/.*\/$/, `${packageName} allowedVersions must be a regex`);
  const allowed = new RegExp((allowedVersions ?? '/.*/').slice(1, -1));
  assert.match(versioning ?? '', /^regex:/, `${currentValue} must get regex versioning`);
  const current = parseRegexVersion(versioning, currentValue);
  return publishedTags
    .map((tag) => ({ tag, version: parseRegexVersion(versioning, tag) }))
    .filter(({ tag, version }) => version && allowed.test(tag) && version.compatibility === current.compatibility)
    .reduce((best, candidate) => (compareReleases(candidate.version.release, best.version.release) > 0 ? candidate : best), {
      tag: currentValue,
      version: current,
    }).tag;
}

function assertAlpineReleaseVersioning(config) {
  // Tags published for nginx as of September 2026, plus the variants that must never be proposed across.
  const nginxTags = [
    '1.26.3-alpine3.20',
    '1.27.3-alpine3.20',
    '1.27.3-alpine3.20-slim',
    '1.31-alpine3.24',
    '1.31.6-alpine3.24',
    '1.31.6-alpine3.24-slim',
    '1.31.6-alpine',
    '1-alpine3.24',
    'mainline-alpine3.24',
  ];
  for (const [currentValue, publishedTags, expected, reason] of [
    ['1.27.3-alpine3.20', nginxTags, '1.31.6-alpine3.24', 'A newer release on a newer Alpine must be proposed'],
    ['1.27.3-alpine3.20', ['1.27.3-alpine3.21'], '1.27.3-alpine3.21', 'A newer Alpine alone must be proposed'],
    ['1.31.6-alpine3.24', ['1.31.6-alpine4.0'], '1.31.6-alpine4.0', 'Alpine 4 must outrank Alpine 3.24'],
    ['1.27.3-alpine3.20-slim', nginxTags, '1.31.6-alpine3.24-slim', 'The -slim variant must stay -slim'],
    ['1.27-alpine3.20', nginxTags, '1.31-alpine3.24', 'A two-component tag must stay two-component'],
    ['1-alpine3.20', nginxTags, '1-alpine3.24', 'A one-component tag must stay one-component'],
  ]) {
    assert.equal(newestCompatibleTag(config, currentValue, publishedTags), expected, `${reason}: ${currentValue}`);
  }

  for (const currentValue of ['1.31.6-alpine', '1.31.6-bookworm', '3.24.1', 'mainline-alpine3.24', '1.31.6-alpine3.24rc1']) {
    assert.equal(
      applyPackageRules({ manager: 'dockerfile', datasource: 'docker', packageName: 'nginx', currentValue }, config.packageRules)
        .versioning,
      undefined,
      `${currentValue} must keep Renovate's default Docker versioning`
    );
  }
  // A copy of workarounds:nodeDockerVersioning, which config:best-practices applies before the inherited rules. Its
  // versionCompatibility would cut 24-alpine3.21 down to 24 before the regex versioning parses it.
  const nodeDockerVersioning = {
    matchDatasources: ['docker'],
    matchPackageNames: ['/(?:^|/)node$/'],
    versionCompatibility: '^(?<version>[^-]+)(?<compatibility>-.*)?$',
    versioning: 'node',
  };
  assert.equal(
    applyPackageRules(
      { manager: 'dockerfile', datasource: 'docker', packageName: 'node', currentValue: '24-alpine3.21' },
      [nodeDockerVersioning, ...config.packageRules]
    ).versionCompatibility,
    null,
    'The Alpine rules must clear the versionCompatibility that workarounds:nodeDockerVersioning sets for node'
  );
  assert.equal(
    applyPackageRules(
      { manager: 'custom.regex', datasource: 'github-releases', packageName: 'example/tool', currentValue: '1.2.3-alpine3.20' },
      config.packageRules
    ).versioning,
    undefined,
    'A non-Docker dependency with an Alpine-like version must keep its versioning'
  );
}

// Netcracker base images tag a release as <os>-<version> or <java>-<os>-<version>. Docker versioning rejects the
// first as an invalid value and reads the second as a Java release, so the inherited config gives them regex
// versioning.
function assertQubershipBaseImageVersioning(config) {
  const coreTags = ['2.5.0', '2.5.8', 'alpine-2.5.0', 'alpine-2.5.8', 'ubi-2.5.0', 'ubi-2.5.8', 'alpine-324-merge-snapshot'];
  const javaTags = ['21-alpine-2.5.0', '21-alpine-2.5.8', '25-alpine-2.5.8', '25-ubi-2.5.0', '25-ubi-2.5.8'];
  const core = 'ghcr.io/netcracker/qubership-core-base';
  const nginx = 'ghcr.io/netcracker/qubership-nginx-base';
  const java = 'ghcr.io/netcracker/qubership-java-base';
  assert.deepEqual(
    {
      'core-base alpine-2.5.0': newestCompatibleTag(config, 'alpine-2.5.0', coreTags, core),
      'core-base ubi-2.5.0': newestCompatibleTag(config, 'ubi-2.5.0', coreTags, core),
      'core-base 2.5.0': newestCompatibleTag(config, '2.5.0', coreTags, core),
      'nginx-base alpine-2.5.0': newestCompatibleTag(config, 'alpine-2.5.0', coreTags, nginx),
      'java-base 21-alpine-2.5.0': newestCompatibleTag(config, '21-alpine-2.5.0', javaTags, java),
      'java-base 25-ubi-2.5.0': newestCompatibleTag(config, '25-ubi-2.5.0', javaTags, java),
    },
    {
      'core-base alpine-2.5.0': 'alpine-2.5.8',
      'core-base ubi-2.5.0': 'ubi-2.5.8',
      'core-base 2.5.0': 'alpine-2.5.8',
      'nginx-base alpine-2.5.0': 'alpine-2.5.8',
      'java-base 21-alpine-2.5.0': '21-alpine-2.5.8',
      'java-base 25-ubi-2.5.0': '25-ubi-2.5.8',
    },
    'A base image tag must move to the newest release with the same OS, and for java-base the same Java release'
  );
  assert.equal(
    applyPackageRules({ manager: 'dockerfile', datasource: 'docker', packageName: core, currentValue: 'latest' }, config.packageRules)
      .replacementVersion,
    'alpine-latest',
    'The legacy latest tag of qubership-core-base must be replaced with alpine-latest'
  );
  assert.equal(
    applyPackageRules(
      { manager: 'dockerfile', datasource: 'docker', packageName: 'ghcr.io/netcracker/qubership-core-base-images', currentValue: 'alpine-2.5.0' },
      config.packageRules
    ).versioning,
    undefined,
    'An image whose name only starts with qubership-core-base must keep Docker versioning'
  );
}

function assertRenovateImageBatching(orgInherited, automerge, githubActions) {
  const image = { manager: 'dockerfile', datasource: 'docker', packageName: 'renovate/renovate' };
  const imageUpdate = (dependency, rules = orgInherited.packageRules) =>
    applyPackageRules({ ...image, ...dependency }, rules);

  // The rule carries no matchManagers, so a Dockerfile, a workflow container and an annotation all reach it; and the
  // pinDigest rule is last, so every update type goes through the whole list.
  for (const packageName of ['renovate/renovate', 'ghcr.io/renovatebot/renovate']) {
    for (const manager of ['dockerfile', 'github-actions', 'custom.regex']) {
      for (const updateType of ['major', 'minor', 'patch', 'digest', 'pinDigest']) {
        const update = imageUpdate({ manager, packageName, updateType });
        const where = `${packageName} ${manager} ${updateType}`;
        assert.deepEqual(update.schedule, ['* * 1 * *'], `${where} updates must open a branch on the first`);
        assert.deepEqual(update.automergeSchedule, ['* * 2-31 * *'], `${where} updates must merge from the second`);
        assert.equal(
          update.platformAutomerge,
          false,
          `${where} updates must merge through Renovate, which follows automergeSchedule`
        );
        assert.equal(update.groupName, 'renovate', `${where} updates must share one PR`);
      }
    }
  }

  // processBranch returns on update-not-scheduled before it reaches the automerge check, so updateNotScheduled: false
  // would leave the monthly PR open for a human to merge.
  assert.equal(
    'updateNotScheduled' in imageUpdate({ updateType: 'patch' }),
    false,
    'renovate/renovate updates must keep updateNotScheduled at its default, or the PR never automerges'
  );

  // The two windows must stay disjoint: a merge inside the branch-creation window frees the next version to open
  // another PR the same day.
  const [branchWindow] = imageUpdate({ updateType: 'patch' }).schedule;
  const [mergeWindow] = imageUpdate({ updateType: 'patch' }).automergeSchedule;
  assert.equal(
    branchWindow.split(' ')[2],
    '1',
    'The branch-creation window must be the first of the month'
  );
  assert.equal(
    mergeWindow.split(' ')[2],
    '2-31',
    'The automerge window must cover the days the branch-creation window leaves out'
  );

  assert.equal(
    imageUpdate({ updateType: 'patch', minimumReleaseAge: orgInherited.minimumReleaseAge }).minimumReleaseAge,
    '7 days',
    'Batching renovate/renovate must keep the seven-day release-age delay'
  );

  // A repository that extends automerge.json appends its rules after the inherited ones and sets platformAutomerge
  // at the top level, which a package rule overrides.
  const automerged = imageUpdate(
    { updateType: 'patch', platformAutomerge: automerge.platformAutomerge },
    [...orgInherited.packageRules, ...automerge.packageRules]
  );
  assert.equal(automerged.automerge, true, 'renovate/renovate patch updates must still automerge');
  assert.equal(
    automerged.platformAutomerge,
    false,
    'automerge.json must not restore platform automerge, which queues the merge when the PR opens'
  );

  // generateBranchConfig takes the branch schedule from the group member that sorts first, so the image must not
  // share a group with dependencies that open at any time.
  for (const updateType of ['patch', 'major']) {
    const grouped = imageUpdate(
      { manager: 'github-actions', updateType },
      [...orgInherited.packageRules, ...githubActions.packageRules]
    );
    assert.equal(
      grouped.groupName,
      'renovate',
      `A ${updateType} update must keep the renovate group when the github-actions preset is extended`
    );
  }

  // Renovate turns vulnerabilityAlerts into a forced package rule appended after the others.
  const vulnerability = imageUpdate({ updateType: 'patch' }, [
    ...orgInherited.packageRules,
    orgInherited.vulnerabilityAlerts,
  ]);
  assert.deepEqual(
    vulnerability.schedule,
    ['at any time'],
    'A vulnerability in the image must open a PR outside the monthly window'
  );

  for (const packageName of ['nginx', 'ghcr.io/netcracker/example']) {
    const other = imageUpdate({ packageName, updateType: 'patch' });
    assert.equal(other.schedule, undefined, `${packageName} updates must open at any time`);
    assert.equal(other.automergeSchedule, undefined, `${packageName} updates must merge at any time`);
    assert.equal(other.platformAutomerge, undefined, `${packageName} updates must keep platform automerge`);
    assert.equal(other.groupName, undefined, `${packageName} updates must not join the renovate group`);
  }

  // matchDatasources keeps the rule off a dependency of the same name from another datasource.
  const nonDocker = imageUpdate({ manager: 'github-actions', datasource: 'github-tags', updateType: 'patch' });
  assert.equal(nonDocker.schedule, undefined, 'A non-Docker renovate/renovate dependency must open at any time');
  assert.equal(nonDocker.groupName, undefined, 'A non-Docker renovate/renovate dependency must stay ungrouped');
}

function assertAutomergePolicy(config) {
  const dockerUpdate = (currentValue, newValue) =>
    applyPackageRules(
      { manager: 'dockerfile', datasource: 'docker', packageName: 'nginx', updateType: 'patch', currentValue, newValue },
      config.packageRules
    ).automerge;
  for (const [currentValue, newValue, expected, reason] of [
    ['1.31.6-alpine3.24', '1.31.6-alpine4.0', false, 'A move to Alpine 4 must wait for review'],
    ['1.31.6-alpine3.24-slim', '1.31.6-alpine4.0-slim', false, 'A move to Alpine 4 must wait for review for a variant too'],
    ['1.27.3-alpine3.20', '1.27.3-alpine3.21', true, 'A move within Alpine 3 must be automerged'],
    ['1.31.5', '1.31.6', true, 'A patch update without Alpine in the tag must be automerged'],
  ]) {
    assert.equal(dockerUpdate(currentValue, newValue), expected, `${reason}: ${currentValue} -> ${newValue}`);
  }
}

// Renovate automerges a grouped branch only when every update in it automerges (generateBranchConfig), so a major of
// a GitHub-published action has to stay out of the group that holds other third-party majors.
function assertGitHubPublishedActionMajors(orgInherited, githubActions, automerge) {
  const outcome = (packageName, updateType, presets) => {
    const update = applyPackageRules(
      { manager: 'github-actions', datasource: 'github-tags', packageName, updateType },
      [orgInherited, ...presets].flatMap((preset) => preset.packageRules)
    );
    return { automerge: update.automerge === true, groupName: update.groupName };
  };
  const automergeOnly = [automerge];
  const withGroups = [githubActions, automerge];
  assert.deepEqual(
    {
      'actions/checkout major, automerge': outcome('actions/checkout', 'major', automergeOnly),
      'github/codeql-action major, automerge': outcome('github/codeql-action', 'major', automergeOnly),
      'docker/build-push-action major, automerge': outcome('docker/build-push-action', 'major', automergeOnly),
      'actions/checkout major, github-actions and automerge': outcome('actions/checkout', 'major', withGroups),
      'github/codeql-action major, github-actions and automerge': outcome('github/codeql-action', 'major', withGroups),
      'docker/build-push-action major, github-actions and automerge': outcome(
        'docker/build-push-action',
        'major',
        withGroups
      ),
      'actions/checkout minor, github-actions and automerge': outcome('actions/checkout', 'minor', withGroups),
    },
    {
      'actions/checkout major, automerge': { automerge: true, groupName: 'actions org' },
      'github/codeql-action major, automerge': { automerge: true, groupName: undefined },
      'docker/build-push-action major, automerge': { automerge: false, groupName: undefined },
      'actions/checkout major, github-actions and automerge': {
        automerge: true,
        groupName: 'major GitHub-published Actions',
      },
      'github/codeql-action major, github-actions and automerge': {
        automerge: true,
        groupName: 'major GitHub-published Actions',
      },
      'docker/build-push-action major, github-actions and automerge': {
        automerge: false,
        groupName: 'major third-party GitHub Actions',
      },
      'actions/checkout minor, github-actions and automerge': {
        automerge: true,
        groupName: 'third-party GitHub Actions',
      },
    },
    'Majors of actions/* and github/* must automerge in a group of their own; other third-party majors must wait for review'
  );
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
    'annotated-versions must override the inherited Docker digest policy'
  );
  assert.equal(
    applyPackageRules(versionOnlyDockerAnnotation, [...config.packageRules, inheritedDigestPinning]).pinDigests,
    true,
    'A Docker digest policy extended after annotated-versions must override it'
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

// Port of smartTruncate from Renovate's lib/modules/platform/utils/pr-body.ts, with the 58000-character limit
// of lib/modules/platform/github/index.ts. It keeps the Configuration section only when the cut falls inside
// "### Release Notes"; otherwise it keeps the head of the body and drops the rest.
const gitHubMaxPrBodyLength = 58000;

function truncatePrBody(input) {
  if (input.length < gitHubMaxPrBodyLength) {
    return input;
  }
  const note = '> ℹ️ **Note**\n> \n> This PR body was truncated due to platform limits.\n\n';
  const truncationNotice = '\n\n> ❗ **Important**\n> \n> ✂️ PR body was truncated to here.\n';
  const truncatedInput = note + input;
  const match = /(?<preNotes>.*### Release Notes)(?<releaseNotes>.*)### Configuration(?<postNotes>.*)/s.exec(
    truncatedInput
  );
  const divider = '\n\n</details>\n\n---\n\n### Configuration';
  const availableLength = match
    ? gitHubMaxPrBodyLength -
      (match.groups.preNotes.length + match.groups.postNotes.length + divider.length + truncationNotice.length)
    : 0;
  if (availableLength <= 0) {
    return truncatedInput.substring(0, gitHubMaxPrBodyLength - truncationNotice.length) + truncationNotice;
  }
  return (
    match.groups.preNotes +
    match.groups.releaseNotes.slice(0, availableLength) +
    truncationNotice +
    divider +
    match.groups.postNotes
  );
}

function renderTruncatedPrBody(template, sections) {
  // Renovate appends its debug comment after rendering the template and before truncating.
  return truncatePrBody(`${render(template, sections)}\n<!--renovate-debug:e30=-->\n`);
}

function assertPrBodyKeepsAutomergeStatus(config) {
  // The sections as Renovate renders them; the notes carry the security advisories.
  const advisory =
    '\n\n---\n\n### jackson-databind: advisory\n\n<details>\n<summary>More information</summary>\n\n' +
    'Details of the advisory.\n'.repeat(200) +
    '\n</details>';
  const sections = {
    header: '',
    table: '| Package | Change |\n|---|---|\n| jackson-databind | `2.17.2` → `2.18.11` |\n',
    warnings: '',
    notes: '',
    changelogs: '\n\n---\n\n### Release Notes\n\n<details>\n\nChangelog line.\n\n</details>',
    configDescription: '\n\n---\n\n### Configuration\n\n🚦 **Automerge**: Enabled.\n\n',
    controls: '\n\n---\n\n - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n\n',
    footer: '',
  };
  const longAdvisories = { ...sections, notes: advisory.repeat(15) };
  const longReleaseNotes = {
    ...sections,
    changelogs: '\n\n---\n\n### Release Notes\n\n<details>\n\n' + 'Changelog line.\n'.repeat(5000) + '\n</details>',
  };
  const renovateDefault =
    '{{{header}}}{{{table}}}{{{warnings}}}{{{notes}}}{{{changelogs}}}{{{configDescription}}}{{{controls}}}{{{footer}}}';

  const defaultBody = renderTruncatedPrBody(renovateDefault, longAdvisories);
  assert.ok(
    defaultBody.includes('PR body was truncated to here'),
    `The advisories fixture must exceed the GitHub limit; the body has ${defaultBody.length} characters`
  );
  assert.ok(
    !defaultBody.includes('**Automerge**: Enabled.'),
    "The advisories fixture must reproduce the loss of the Automerge status under Renovate's default template"
  );

  for (const [name, fixture] of Object.entries({ longAdvisories, longReleaseNotes })) {
    const body = renderTruncatedPrBody(config.prBodyTemplate, fixture);
    assert.ok(
      body.includes('PR body was truncated to here'),
      `${name}: the fixture must exceed the GitHub limit; the body has ${body.length} characters`
    );
    assert.ok(
      body.includes('🚦 **Automerge**: Enabled.'),
      `${name}: prBodyTemplate must keep the Automerge status in a truncated body`
    );
    assert.ok(
      body.includes('<!-- rebase-check -->'),
      `${name}: prBodyTemplate must keep the rebase checkbox in a truncated body`
    );
  }
}

const configs = Object.fromEntries(presetNames.map((name) => [name, readJson(`${name}.json`)]));
assertRepositoryPolicy(readJson('renovate.json'));
const orgInherited = readJson('org-inherited-config.json');
const automerge = readJson('automerge.json');
assertOrgInheritedPolicy(orgInherited);
assertAlpineReleaseVersioning(orgInherited);
assertQubershipBaseImageVersioning(orgInherited);
assertRenovateImageBatching(orgInherited, automerge, configs['github-actions']);
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
assertAutomergePolicy(automerge);
assertGitHubPublishedActionMajors(orgInherited, configs['github-actions'], automerge);
assertPrBodyKeepsAutomergeStatus(orgInherited);

console.log(`Validated ${presetNames.length} capability presets and their extraction fixtures.`);
