import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('apm.json', 'utf8'));
const apmPackageRule = config.packageRules.find((rule) => rule.matchDepTypes?.includes('apm'));
const gitRefManager = config.customManagers.find((manager) =>
  manager.description === 'Pin and update APM dependencies that reference Git refs.'
);
const marketplaceManager = config.customManagers.find((manager) =>
  manager.description === 'Update marketplace APM package entries pinned to immutable Git refs.'
);

if (!apmPackageRule) {
  throw new Error('APM package rule was not found');
}

if (apmPackageRule.groupName !== 'apm packages') {
  throw new Error('APM package rule must group package updates');
}

if (!gitRefManager) {
  throw new Error('Git ref APM custom manager was not found');
}

if (!marketplaceManager) {
  throw new Error('Marketplace APM custom manager was not found');
}

const regex = new RegExp(marketplaceManager.matchStrings[0], 'g');
const fixture = `marketplace:
  packages:
    - name: ai-agent-telemetry
      source: Netcracker/qubership-ai-agent-telemetry
      subdir: agent-packages/ai-agent-telemetry
      ref: c9ab85efe02149166e385f5962e1735d531e64d7  # main
      tags: ["topic:observability", "activity:telemetry", "audience:public"]

    - name: ai-agent-telemetry-configure
      source: Netcracker/qubership-ai-agent-telemetry
      subdir: agent-packages/ai-agent-telemetry-configure
      ref: c9ab85efe02149166e385f5962e1735d531e64d7  # main
      tags: ["topic:observability", "activity:telemetry", "audience:public"]
`;

const matches = [...fixture.matchAll(regex)];
const depNames = matches.map((match) => `${match.groups.packageName}/${match.groups.apmSubdir}`);

const expected = [
  'Netcracker/qubership-ai-agent-telemetry/agent-packages/ai-agent-telemetry',
  'Netcracker/qubership-ai-agent-telemetry/agent-packages/ai-agent-telemetry-configure',
];

if (JSON.stringify(depNames) !== JSON.stringify(expected)) {
  throw new Error(`Marketplace APM regex matched ${JSON.stringify(depNames)}, expected ${JSON.stringify(expected)}`);
}

for (const match of matches) {
  if (!match[0].startsWith('- name:')) {
    throw new Error(`Marketplace APM regex must match a complete package item, got ${JSON.stringify(match[0])}`);
  }
}

const digestFixture = `dependencies:
  apm:
    - Netcracker/qubership-ai-packages/agent-packages/apm-authoring#0ce60887d9c585522cfb58b1d9647ebe595fe569  # main
    - Netcracker/qubership-ai-packages/agent-packages/adr-authoring#0ce60887d9c585522cfb58b1d9647ebe595fe569  # main
`;

function replaceDigest(manager, content, dependencyIndex, newDigest) {
  const managerRegex = new RegExp(manager.matchStrings[0], 'g');
  const managerMatches = [...content.matchAll(managerRegex)];
  const match = managerMatches[dependencyIndex];

  if (!match) {
    throw new Error(`Dependency index ${dependencyIndex} was not found`);
  }

  let replacement;
  if (manager.autoReplaceStringTemplate) {
    const templateValues = {
      depName: match.groups.depName,
      packageName: match.groups.packageName,
      currentValue: match.groups.currentValue,
      currentDigest: match.groups.currentDigest,
      indentation: match.groups.indentation,
      newDigest,
    };
    replacement = manager.autoReplaceStringTemplate.replaceAll(
      /\{\{\{([^}]+)}}}/g,
      (_, field) => templateValues[field] ?? ''
    );
  } else {
    replacement = match[0].replace(match.groups.currentDigest, newDigest);
  }

  return `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
}

function assertDependencyCountPreserved(manager, content, dependencyIndex) {
  const managerRegex = new RegExp(manager.matchStrings[0], 'g');
  const before = [...content.matchAll(managerRegex)];
  const updated = replaceDigest(manager, content, dependencyIndex, 'b3a0a1582ab3728efdd52c6765f51a6bc75d51af');
  const after = [...updated.matchAll(managerRegex)];

  if (after.length !== before.length) {
    throw new Error(`Digest replacement changed dependency count from ${before.length} to ${after.length}`);
  }
}

assertDependencyCountPreserved(gitRefManager, digestFixture, 1);
assertDependencyCountPreserved(marketplaceManager, fixture, 0);

const supportedTemplateFields = new Set([
  'currentDigest',
  'currentValue',
  'datasource',
  'depName',
  'depType',
  'extractVersion',
  'indentation',
  'newDigest',
  'newValue',
  'packageName',
  'registryUrl',
  'versioning',
]);
const mutableTemplateFields = [...gitRefManager.autoReplaceStringTemplate.matchAll(/\{\{\{([^}]+)}}}/g)].map(
  (match) => match[1]
);
const unsupportedTemplateFields = mutableTemplateFields.filter((field) => !supportedTemplateFields.has(field));

if (unsupportedTemplateFields.length > 0) {
  throw new Error(`Mutable Git ref replacement uses unsupported fields: ${unsupportedTemplateFields.join(', ')}`);
}

const mutableFixture = `dependencies:
  apm:
    - Netcracker/example/agent-packages/example#main
`;
const mutableRegex = new RegExp(gitRefManager.matchStrings[0], 'g');
const mutableMatch = [...mutableFixture.matchAll(mutableRegex)][0];
const mutableValues = {
  ...mutableMatch.groups,
  newDigest: '4594b3b9d09c066ec549f4b6cee2eb1266c7f948',
};
const pinnedDependency = gitRefManager.autoReplaceStringTemplate.replaceAll(
  /\{\{\{([^}]+)}}}/g,
  (_, field) => mutableValues[field] ?? ''
);
const pinnedFixture = `${mutableFixture.slice(0, mutableMatch.index)}${pinnedDependency}${mutableFixture.slice(
  mutableMatch.index + mutableMatch[0].length
)}`;

if ([...pinnedFixture.matchAll(new RegExp(gitRefManager.matchStrings[0], 'g'))].length !== 1) {
  throw new Error('Pinned mutable Git ref must still be detected by the manager that pinned it');
}
