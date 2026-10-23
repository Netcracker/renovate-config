import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('apm.json', 'utf8'));

const apmPackageRule = config.packageRules.find((rule) => rule.matchDepTypes?.includes('apm'));
const depsBranchManager = config.customManagers.find(
  (manager) => manager.description === 'Update APM dependencies pinned to a commit on a branch.'
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
if (!apmPackageRule.matchDepTypes.includes('apm-dev')) {
  throw new Error('APM package rule must also match apm-dev, the built-in manager\'s dependency type for devDependencies');
}
if (apmPackageRule.automerge !== false) {
  throw new Error('APM updates must stay under manual review (automerge: false)');
}

for (const [name, manager, datasource] of [
  ['dependency branch', depsBranchManager, 'git-refs'],
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
if (marketReleaseManager.versioningTemplate !== 'semver') {
  throw new Error('Marketplace release manager must use semver versioning');
}

function hasNamedDigest(manager) {
  return manager.matchStrings.some((matchString) => /\(\?<currentDigest>/.test(matchString));
}

// A dependency pinned to a commit on a branch keeps its SHA: in a published package's apm.yml that SHA is the only pin
// its consumers receive, because the package repository's own apm.lock does not travel with the package.
if (!hasNamedDigest(depsBranchManager)) {
  throw new Error('Dependency branch manager must keep the SHA pin (currentDigest)');
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

// Renovate's built-in apm manager updates dependencies on a tag (#v1.2.0, #<sha>  # v1.2.0). It looks any other ref up
// as a tag too, so for a branch pin it reports "Could not determine new digest"; the rule turns it off there and leaves
// those pins to the branch manager.
const builtinBranchRule = config.packageRules.find(
  (rule) => rule.matchManagers?.includes('apm') && rule.enabled === false
);
if (!builtinBranchRule) {
  throw new Error('A package rule must turn the built-in apm manager off for branch refs');
}
const negated = /^!\/(.*)\/$/.exec(builtinBranchRule.matchCurrentValue ?? '');
if (!negated) {
  throw new Error(`Built-in apm rule must match a negated regex, got ${JSON.stringify(builtinBranchRule.matchCurrentValue)}`);
}
const versionRef = new RegExp(negated[1]);
for (const branch of ['main', 'develop', 'feat/agent-packages', 'vNext']) {
  if (versionRef.test(branch)) {
    throw new Error(`Built-in apm rule must turn the manager off for branch ${JSON.stringify(branch)}`);
  }
}
// `v1.x` is a branch, but without a lookahead it cannot be told from a tag, so it stays with the built-in manager.
for (const tag of ['v1.2.0', 'V1.2.0', 'v0.1.0-rc.1', '1.2.0', 'v1.x']) {
  if (!versionRef.test(tag)) {
    throw new Error(`Built-in apm rule must leave the manager on for tag ${JSON.stringify(tag)}`);
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

const oldDigest = '96f42e9a2a694632f3ef355ce45ad33c13906220';
const newDigest = 'f7d7b53f2eb840645236cd46d60750db53f0ef6e';

// Dependencies on a tag, which belong to the built-in apm manager.
const tagPinFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-agent-telemetry/agent-packages/ai-agent-telemetry#${oldDigest}  # v0.1.0
`;
const tagFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-agent-telemetry/agent-packages/ai-agent-telemetry#v0.1.0
`;

// --- Dependency pinned to a commit on a branch: keep the SHA pin, update the digest, keep the branch comment. ---
const branchDependencyFixture = `dependencies:
  apm:
    - Netcracker/qubership-core-lib-go/logging/agent-packages/logging-go-usage#${oldDigest}  # feat/agent-packages
`;
const branchDependencyMatch = firstMatch(depsBranchManager, branchDependencyFixture);
if (
  branchDependencyMatch?.groups.currentValue !== 'feat/agent-packages' ||
  branchDependencyMatch.groups.currentDigest !== oldDigest
) {
  throw new Error(`Dependency branch manager captured ${JSON.stringify(branchDependencyMatch?.groups)}`);
}
const branchDependency = extractRuntimeDependency(depsBranchManager, branchDependencyMatch);
if (branchDependency.packageName !== 'https://github.com/Netcracker/qubership-core-lib-go.git') {
  throw new Error(`Dependency branch packageName was ${JSON.stringify(branchDependency.packageName)}`);
}
if (branchDependency.depName !== 'Netcracker/qubership-core-lib-go/logging/agent-packages/logging-go-usage') {
  throw new Error(`Dependency branch depName was ${JSON.stringify(branchDependency.depName)}`);
}
const bumpedBranchDependency = replaceFirstMatch(depsBranchManager, branchDependencyFixture, { newDigest });
if (!bumpedBranchDependency.includes(`/logging-go-usage#${newDigest}  # feat/agent-packages`)) {
  throw new Error(`Dependency branch bump must update the digest and keep the branch, got:\n${bumpedBranchDependency}`);
}

// A pin on a whole repository, with no subdirectory, is a branch pin too.
const wholeRepoMatch = firstMatch(depsBranchManager, `dependencies:
  apm:
    - Netcracker/qubership-workflow-hub#${oldDigest}  # main
`);
if (wholeRepoMatch?.groups.depName !== 'Netcracker/qubership-workflow-hub' || wholeRepoMatch.groups.currentValue !== 'main') {
  throw new Error(`Dependency branch manager must capture a pin on a whole repository, got ${JSON.stringify(wholeRepoMatch?.groups)}`);
}

// A branch whose name starts with `v` and a letter is a branch, not a tag.
const vBranchMatch = firstMatch(depsBranchManager, branchDependencyFixture.replace('# feat/agent-packages', '# vNext'));
if (vBranchMatch?.groups.currentValue !== 'vNext') {
  throw new Error(`Dependency branch manager must capture a v-prefixed branch, got ${JSON.stringify(vBranchMatch?.groups)}`);
}

// A comment on the next line belongs to that line, not to the SHA above it.
for (const comment of ['# main', '# v1.2.0']) {
  const splitFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-packages/agent-packages/apm-authoring#${newDigest}
    ${comment}
`;
  if (firstMatch(depsBranchManager, splitFixture)) {
    throw new Error(`Dependency branch manager must not join a SHA with the comment line after it (${comment})`);
  }
}

for (const fixture of [tagPinFixture, tagFixture]) {
  if (firstMatch(depsBranchManager, fixture)) {
    throw new Error(`Dependency branch manager must not match a version tag:\n${fixture}`);
  }
}

// A bare branch ref such as `#main` follows the branch at install time and holds no SHA to update.
const bareBranchFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-packages/agent-packages/apm-authoring#main
`;
if (firstMatch(depsBranchManager, bareBranchFixture)) {
  throw new Error('Dependency branch manager must not extract a bare branch ref');
}

// A bare SHA with no comment names no ref to follow, even one that starts with a letter.
const bareDigestFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-packages/agent-packages/apm-authoring#${newDigest}
`;
if (firstMatch(depsBranchManager, bareDigestFixture)) {
  throw new Error('Dependency branch manager must not extract a bare SHA');
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
