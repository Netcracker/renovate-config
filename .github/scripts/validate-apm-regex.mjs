import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('apm.json', 'utf8'));
const marketplaceManager = config.customManagers.find((manager) =>
  manager.description === 'Update marketplace APM package entries pinned to immutable Git refs.'
);

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
