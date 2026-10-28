import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('apm.json', 'utf8'));

const apmPackageRule = config.packageRules.find((rule) => rule.matchDepTypes?.includes('apm'));
const depsManager = config.customManagers.find(
  (manager) => manager.description === 'Update APM dependencies pinned to version tags with #.'
);
const marketReleaseManager = config.customManagers.find(
  (manager) => manager.description === 'Update marketplace APM entries pinned to release tags.'
);
const marketBranchManager = config.customManagers.find(
  (manager) => manager.description === 'Update marketplace APM entries pinned to branches.'
);

if (!apmPackageRule) {
  throw new Error('APM package rule was not found');
}
if (apmPackageRule.groupName !== 'apm packages') {
  throw new Error('APM package rule must group package updates');
}
if (apmPackageRule.pinDigests === true) {
  throw new Error('APM package rule must not pin digests in dependencies; SHAs there belong in apm.lock');
}
if (apmPackageRule.automerge !== false) {
  throw new Error('APM updates must stay under manual review (automerge: false)');
}

// Renovate's built-in apm manager extracts devDependencies.apm as depType apm-dev.
if (!apmPackageRule.matchDepTypes.includes('apm-dev')) {
  throw new Error(
    'APM package rule in apm.json must also match depType apm-dev, which Renovate\'s apm manager gives ' +
      `devDependencies, got matchDepTypes ${JSON.stringify(apmPackageRule.matchDepTypes)}; without it, an APM ` +
      "devDependencies update gets a branch of its own outside the apm packages group, and the automerge preset's " +
      'digest rule can merge it'
  );
}
const gitRefsReleaseAgeRule = config.packageRules.find(
  (rule) => rule.matchDatasources?.includes('git-refs') && 'minimumReleaseAge' in rule
);
if (!gitRefsReleaseAgeRule) {
  throw new Error('APM git-refs release-age rule was not found');
}
if (!gitRefsReleaseAgeRule.matchDepTypes?.includes('apm-dev')) {
  throw new Error(
    'APM git-refs release-age rule in apm.json must also match depType apm-dev, got matchDepTypes ' +
      `${JSON.stringify(gitRefsReleaseAgeRule.matchDepTypes)}; git-refs reports no release timestamp, so without it ` +
      'an APM devDependencies update outside Netcracker/** is held as pending by minimumReleaseAge and never opened'
  );
}

// The built-in apm manager reads the comment in package#<sha>  # main as a release tag and looks the dependency up
// with github-tags, which has no tag named main. This rule looks up such a pin as a branch through git-refs.
const branchPinRule = config.packageRules.find((rule) => rule.overrideDatasource === 'git-refs');
if (!branchPinRule) {
  throw new Error(
    'apm.json has no packageRule with overrideDatasource git-refs; without it, a dependency pinned as ' +
      'package#<sha>  # main is looked up as a tag named main, never updated, and reported on the Dependency ' +
      'Dashboard as "Could not determine new digest for update (github-tags package <owner>/<repo>)"'
  );
}
if (
  JSON.stringify(branchPinRule.matchManagers) !== JSON.stringify(['apm']) ||
  JSON.stringify(branchPinRule.matchDatasources) !== JSON.stringify(['github-tags'])
) {
  throw new Error(
    `The APM branch-pin rule in apm.json must match only manager apm on datasource github-tags, got matchManagers ` +
      `${JSON.stringify(branchPinRule.matchManagers)} and matchDatasources ` +
      `${JSON.stringify(branchPinRule.matchDatasources)}; the custom managers set their own datasources`
  );
}
if (branchPinRule.versioning !== 'git') {
  throw new Error(
    `The APM branch-pin rule in apm.json must set versioning to git, got ${JSON.stringify(branchPinRule.versioning)}; ` +
      "the apm manager's default versioning reads a digit in a branch name, as in feat/apm-2, as a version and " +
      'offers to replace the branch pin with a release tag'
  );
}
if (branchPinRule.overridePackageName !== 'https://github.com/{{{packageName}}}.git') {
  throw new Error(
    'The APM branch-pin rule in apm.json must set overridePackageName to https://github.com/{{{packageName}}}.git, ' +
      `got ${JSON.stringify(branchPinRule.overridePackageName)}; git-refs takes a clone URL, and the apm manager ` +
      'gives packageName as owner/repo'
  );
}

// matchCurrentValue "!/<regex>/" applies the rule to a comment the regex does not match.
const negatedReleaseTagPattern = /^!\/(.+)\/$/.exec(branchPinRule.matchCurrentValue ?? '');
if (!negatedReleaseTagPattern) {
  throw new Error(
    `The APM branch-pin rule in apm.json must set matchCurrentValue to a negated regex "!/<regex>/" that matches a ` +
      `release tag, got ${JSON.stringify(branchPinRule.matchCurrentValue)}`
  );
}
const releaseTagPattern = new RegExp(negatedReleaseTagPattern[1]);
const misclassifiedComments = [
  ...[
    'main',
    'develop',
    'feat/agent-packages',
    'feature/ABC-1234',
    'feat/apm-2',
    'lts/26.1',
    'release/1.2.0',
    'release/v1.0.7',
    'v1.2',
  ]
    .filter((comment) => releaseTagPattern.test(comment))
    .map((comment) => `"${comment}" names a branch but stays a github-tags lookup`),
  ...['v1.3.1', '1.2.0', '2.6.3', 'v1.2.3-rc.1', 'v1.2.3+build.4', 'ai-agent-telemetry-v1.2.0']
    .filter((comment) => !releaseTagPattern.test(comment))
    .map((comment) => `"${comment}" is a release tag but goes to git-refs`),
];
if (misclassifiedComments.length > 0) {
  throw new Error(
    `The APM branch-pin rule's matchCurrentValue ${branchPinRule.matchCurrentValue} in apm.json misclassifies ` +
      `${misclassifiedComments.length} comment(s): ${misclassifiedComments.join('; ')}`
  );
}

for (const [name, manager, datasource] of [
  ['dependencies', depsManager, 'github-tags'],
  ['marketplace release', marketReleaseManager, 'github-tags'],
  ['marketplace branch', marketBranchManager, 'git-refs'],
]) {
  if (!manager) {
    throw new Error(`${name} APM custom manager was not found`);
  }
  if (manager.datasourceTemplate !== datasource) {
    throw new Error(`${name} APM manager must use the ${datasource} datasource, got ${manager.datasourceTemplate}`);
  }
}
for (const manager of [depsManager, marketReleaseManager]) {
  if (manager.versioningTemplate !== 'semver') {
    throw new Error(`Tag-tracking APM manager ${JSON.stringify(manager.description)} must use semver versioning`);
  }
}

function hasNamedDigest(manager) {
  return manager.matchStrings.some((matchString) => /\(\?<currentDigest>/.test(matchString));
}

// Dependencies (apm.lock covers them): apm.yml keeps no SHA, so the manager must not read or emit a digest.
if (hasNamedDigest(depsManager)) {
  throw new Error('Dependencies manager must not capture currentDigest; SHAs there live in apm.lock, not apm.yml');
}
if (depsManager.autoReplaceStringTemplate.includes('newDigest')) {
  throw new Error('Dependencies manager must not write a digest back into apm.yml');
}

// Marketplace (not covered by any lockfile): the SHA pin is the lock, so both managers keep and update the digest.
for (const manager of [marketReleaseManager, marketBranchManager]) {
  if (!hasNamedDigest(manager)) {
    throw new Error(`Marketplace manager ${JSON.stringify(manager.description)} must keep the SHA pin (currentDigest)`);
  }
  if (manager.matchStrings.some((matchString) => matchString.includes('(?<depPrefix>'))) {
    throw new Error(`Marketplace manager ${JSON.stringify(manager.description)} must not capture unused depPrefix`);
  }
}

// Renovate keeps only these fields from the regex captures; every other group is dropped at extraction.
const extractedFields = [
  'currentDigest',
  'currentValue',
  'datasource',
  'depName',
  'depType',
  'extractVersion',
  'indentation',
  'packageName',
  'registryUrl',
  'versioning',
];

function render(template, values) {
  return template.replaceAll(/\{\{\{([^}]+)}}}/g, (_, field) => values[field] ?? '');
}

function extractRuntimeDependency(manager, match) {
  const dependency = {};
  for (const field of extractedFields) {
    const template = manager[`${field}Template`];
    const value = template ? render(template, match.groups) : match.groups[field];
    if (value !== undefined) {
      dependency[field] = value;
    }
  }
  dependency.replaceString = match[0];
  return dependency;
}

function replaceDependency(manager, match, update) {
  const dependency = extractRuntimeDependency(manager, match);
  if (manager.autoReplaceStringTemplate) {
    return render(manager.autoReplaceStringTemplate, { ...dependency, ...update });
  }

  let replacement = match[0];
  if (dependency.currentValue && update.newValue) {
    replacement = replacement.replace(dependency.currentValue, update.newValue);
  }
  if (dependency.currentDigest && update.newDigest) {
    replacement = replacement.replace(dependency.currentDigest, update.newDigest);
  }
  return replacement;
}

function firstMatch(manager, content) {
  return new RegExp(manager.matchStrings[0], 'g').exec(content);
}

function replaceFirstMatch(manager, content, update) {
  const match = firstMatch(manager, content);
  if (!match) {
    throw new Error(`Manager ${JSON.stringify(manager.description)} matched nothing in the fixture`);
  }
  const replacement = replaceDependency(manager, match, update);
  return `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
}

function countMatches(manager, content) {
  return [...content.matchAll(new RegExp(manager.matchStrings[0], 'g'))].length;
}

const oldDigest = '96f42e9a2a694632f3ef355ce45ad33c13906220';
const newDigest = 'f7d7b53f2eb840645236cd46d60750db53f0ef6e';

// --- Dependencies: a legacy digest pin collapses to a clean tag on the first bump. ---
const legacyHashFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-agent-telemetry/agent-packages/ai-agent-telemetry#${oldDigest}  # v0.1.0
    - Netcracker/qubership-ai-packages/agent-packages/apm-authoring#main
`;
const bumpedHash = replaceFirstMatch(depsManager, legacyHashFixture, { newValue: 'v1.0.1' });
if (!bumpedHash.includes('/ai-agent-telemetry#v1.0.1')) {
  throw new Error(`Bumped dependency must become a clean tag, got:\n${bumpedHash}`);
}
if (/[0-9a-f]{40}/.test(bumpedHash) || bumpedHash.includes('  # ')) {
  throw new Error(`Bumped dependency must drop the digest and its comment, got:\n${bumpedHash}`);
}
if (countMatches(depsManager, legacyHashFixture) !== countMatches(depsManager, bumpedHash)) {
  throw new Error('Bumping a dependency must preserve the dependency count');
}

const cleanHashFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-agent-telemetry/agent-packages/ai-agent-telemetry#v0.1.0
`;
const bumpedClean = replaceFirstMatch(depsManager, cleanHashFixture, { newValue: 'v1.0.1' });
if (!bumpedClean.includes('/ai-agent-telemetry#v1.0.1') || /[0-9a-f]{40}/.test(bumpedClean)) {
  throw new Error(`Clean dependency tag must bump without gaining a digest, got:\n${bumpedClean}`);
}

// A branch dependency is recognized but never regains a digest.
const branchDependencyFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-packages/agent-packages/apm-authoring#${oldDigest}  # main
`;
const branchDependencyMatch = firstMatch(depsManager, branchDependencyFixture);
if (branchDependencyMatch?.groups.currentValue !== 'main') {
  throw new Error(`Dependencies manager must read the branch name, got ${JSON.stringify(branchDependencyMatch?.groups.currentValue)}`);
}
const collapsedBranch = replaceDependency(depsManager, branchDependencyMatch, { newValue: 'main' });
if (/[0-9a-f]{40}/.test(collapsedBranch) || collapsedBranch.includes('  # ')) {
  throw new Error(`Collapsing a branch dependency must drop the digest, got: ${JSON.stringify(collapsedBranch)}`);
}

// The invalid `@alias` shorthand (rejected by APM 0.26.0) must not be extracted by any manager.
const atShorthandFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-agent-telemetry/agent-packages/ai-agent-telemetry@v1.2.0
`;
for (const manager of config.customManagers) {
  const match = firstMatch(manager, atShorthandFixture);
  if (match?.groups?.currentValue === 'v1.2.0') {
    throw new Error(`APM manager ${JSON.stringify(manager.description)} must not extract the invalid @v1.2.0 shorthand`);
  }
}

// --- Marketplace release entry: keep the SHA pin and update both digest and tag. ---
const marketReleaseFixture = `marketplace:
  packages:
    - name: ai-agent-telemetry
      source: Netcracker/qubership-ai-agent-telemetry
      subdir: agent-packages/ai-agent-telemetry
      ref: ${oldDigest}  # v0.1.0
      tags: ["topic:observability"]
`;
const releaseMatch = firstMatch(marketReleaseManager, marketReleaseFixture);
if (!releaseMatch) {
  throw new Error('Marketplace release manager must match a version-tag entry');
}
if (releaseMatch.groups.currentValue !== 'v0.1.0' || releaseMatch.groups.currentDigest !== oldDigest) {
  throw new Error(`Marketplace release manager captured ${JSON.stringify(releaseMatch.groups)}`);
}
if (releaseMatch.groups.packageName !== 'Netcracker/qubership-ai-agent-telemetry') {
  throw new Error(`Marketplace release packageName was ${JSON.stringify(releaseMatch.groups.packageName)}`);
}
const bumpedRelease = replaceFirstMatch(marketReleaseManager, marketReleaseFixture, { newDigest, newValue: 'v1.0.1' });
if (!bumpedRelease.includes(`ref: ${newDigest}  # v1.0.1`)) {
  throw new Error(`Marketplace release bump must update both digest and tag, got:\n${bumpedRelease}`);
}
if (bumpedRelease.includes(oldDigest)) {
  throw new Error(`Marketplace release bump must replace the old digest, got:\n${bumpedRelease}`);
}
if (firstMatch(marketReleaseManager, marketReleaseFixture.replace('# v0.1.0', '# main'))) {
  throw new Error('Marketplace release manager must not match a branch ref');
}

// The full semver range (prerelease and build metadata, together) must be accepted.
for (const value of ['v1.2.3', 'v1.2.3-rc.1', 'v1.2.3+build.4', 'v1.2.3-rc.1+build.4']) {
  const fixture = marketReleaseFixture.replace('# v0.1.0', `# ${value}`);
  const match = firstMatch(marketReleaseManager, fixture);
  if (match?.groups.currentValue !== value) {
    throw new Error(`Marketplace release manager must capture ${JSON.stringify(value)}, got ${JSON.stringify(match?.groups.currentValue)}`);
  }
}

// --- Marketplace branch entry: keep the SHA pin, update the digest, keep the branch comment. ---
const marketBranchFixture = `marketplace:
  packages:
    - name: ai-agent-telemetry
      source: Netcracker/qubership-ai-agent-telemetry
      subdir: agent-packages/ai-agent-telemetry
      ref: ${oldDigest}  # main
`;
const branchMatch = firstMatch(marketBranchManager, marketBranchFixture);
if (!branchMatch || branchMatch.groups.currentValue !== 'main' || branchMatch.groups.currentDigest !== oldDigest) {
  throw new Error(`Marketplace branch manager captured ${JSON.stringify(branchMatch?.groups)}`);
}
const bumpedBranch = replaceFirstMatch(marketBranchManager, marketBranchFixture, { newDigest });
if (!bumpedBranch.includes(`ref: ${newDigest}  # main`) || bumpedBranch.includes(oldDigest)) {
  throw new Error(`Marketplace branch bump must update the digest and keep the branch, got:\n${bumpedBranch}`);
}
if (firstMatch(marketBranchManager, marketReleaseFixture)) {
  throw new Error('Marketplace branch manager must not match a version-tag ref');
}

// Updating one grouped dependency must preserve every marketplace entry and its extraction order.
const groupedBranchFixture = `marketplace:
  packages:
    - name: api-diff-authoring
      source: Netcracker/qubership-apihub-api-diff
      subdir: agent-packages/api-diff-authoring
      ref: 7b0bf733df7288bf051ec2e5719d7ffc2753566f  # develop

    - name: api-unifier-authoring
      source: Netcracker/qubership-apihub-api-unifier
      subdir: agent-packages/api-unifier-authoring
      ref: 635ce729bd94f42a61a1c036bc3b066a20ab7755  # develop

    - name: api-unifier-testing
      source: Netcracker/qubership-apihub-api-unifier
      subdir: agent-packages/api-unifier-testing
      ref: 635ce729bd94f42a61a1c036bc3b066a20ab7755  # develop
`;
const groupedMatches = [...groupedBranchFixture.matchAll(new RegExp(marketBranchManager.matchStrings[0], 'g'))];
const groupedDepNames = groupedMatches.map((match) => extractRuntimeDependency(marketBranchManager, match).depName);
if (groupedDepNames.length !== 3) {
  throw new Error(`Grouped marketplace fixture must yield three dependencies, got ${JSON.stringify(groupedDepNames)}`);
}
const updatedFirstBranch = replaceFirstMatch(marketBranchManager, groupedBranchFixture, {
  newDigest: '29c324bf6e893195c8c87eb1b5992947b7f64d6f',
});
const updatedGroupedMatches = [...updatedFirstBranch.matchAll(new RegExp(marketBranchManager.matchStrings[0], 'g'))];
const updatedGroupedDepNames = updatedGroupedMatches.map(
  (match) => extractRuntimeDependency(marketBranchManager, match).depName
);
if (JSON.stringify(updatedGroupedDepNames) !== JSON.stringify(groupedDepNames)) {
  throw new Error(
    `Marketplace branch update changed dependency extraction from ${JSON.stringify(groupedDepNames)} to ${JSON.stringify(updatedGroupedDepNames)}`
  );
}
if (!updatedFirstBranch.includes('ref: 29c324bf6e893195c8c87eb1b5992947b7f64d6f  # develop')) {
  throw new Error(`Marketplace branch update did not preserve the package block:\n${updatedFirstBranch}`);
}

// Captured values must span the whole ref token, so a malformed value never leaves a suffix behind.
const overlongRelease = firstMatch(marketReleaseManager, marketReleaseFixture.replace('# v0.1.0', '# v0.1.0.1'));
if (overlongRelease?.groups.currentValue !== 'v0.1.0.1') {
  throw new Error(`Release manager must capture the whole token, got ${JSON.stringify(overlongRelease?.groups.currentValue)}`);
}
const dottedBranch = firstMatch(marketBranchManager, marketBranchFixture.replace('# main', '# main.foo'));
if (dottedBranch?.groups.currentValue !== 'main.foo') {
  throw new Error(`Branch manager must capture the whole token, got ${JSON.stringify(dottedBranch?.groups.currentValue)}`);
}

console.log('APM regex behavior checks passed');
