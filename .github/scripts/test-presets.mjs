import assert from 'node:assert/strict';
import fs from 'node:fs';

const presetNames = [
  'base',
  'github-actions',
  'go',
  'go-tidy',
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

function compileManager(manager) {
  return manager.matchStrings.map((matchString) => new RegExp(matchString, 'g'));
}

function managerMatchesPath(manager, path) {
  return manager.managerFilePatterns.some((pattern) => {
    assert.match(pattern, /^\/.+\/$/, `Test runner does not support non-regex file pattern: ${pattern}`);
    return new RegExp(pattern.slice(1, -1)).test(path);
  });
}

function extract(manager, content) {
  return compileManager(manager).flatMap((regex) => [...content.matchAll(regex)].map((match) => match.groups));
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
    .replaceAll(/\{\{\{replace '\^v' '' ([^}]+)}}}/g, (_, field) => (values[field] ?? '').replace(/^v/, ''))
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
  assert.deepEqual(thirdParty.matchPackageNames, ['!Netcracker/**', '!netcracker/**']);
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
    'Group Go toolchain updates',
  ]) {
    findRule(config, description);
  }
  assert.equal(config.packageRules.length, 4, 'go.json must not group unrelated Go dependencies');
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
}

function assertGoTidyPolicy(config) {
  const rule = findRule(config, 'Run go mod tidy after Go module updates');
  assert.deepEqual(rule.matchManagers, ['gomod']);
  assert.deepEqual(rule.postUpdateOptions, ['gomodTidy']);
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

function assertAnnotatedVersions(config) {
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
  assert.equal(manager.depNameTemplate, 'alpine');
  assert.equal(manager.packageNameTemplate, 'alpine');
  assert.equal(manager.versioningTemplate, 'docker');
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
      packageName: dependencies[0].alpinePackage,
      packageVersioning: dependencies[0].packageVersioning,
    },
    {
      currentValue: '3_23',
      packageName: 'busybox',
      packageVersioning: 'apk',
    }
  );

  const replacement = render(manager.autoReplaceStringTemplate, {
    ...dependencies[0],
    newMajor: '3',
    newMinor: '25',
  });
  assert.equal(
    replacement,
    '# renovate: datasource=repology depName=alpine_3_25/busybox versioning=apk syncWith=alpine'
  );

  const rule = findRule(config, 'Group Alpine image and synchronized Repology repository updates');
  assert.deepEqual(rule.matchDatasources, ['docker']);
  assert.deepEqual(rule.matchPackageNames, ['alpine']);
  assert.equal(rule.groupName, 'alpine-release');

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
assertBasePolicy(configs.base);
assertGitHubActionsPolicy(configs['github-actions']);
assertGoPolicy(configs.go);
assertGoTidyPolicy(configs['go-tidy']);
assertNetcrackerPolicy(configs['netcracker-dependencies']);
assertTestPipelines(configs['test-pipelines']);
assertAnnotatedVersions(configs['annotated-versions']);
assertAlpineRepologySync(configs['annotated-versions']);
assertGrafanaPlugins(configs['grafana-plugins']);
assertGraylogPlugins(configs['graylog-plugins']);
assertNoAutomerge(configs);

console.log(`Validated ${presetNames.length} capability presets and their extraction fixtures.`);
