import assert from 'node:assert/strict';
import fs from 'node:fs';

// Reads the JSON log of `renovate --platform=local --dry-run=extract` run over tests/fixtures/ignore-paths with
// org-inherited-config.json as its only preset, and checks which package files Renovate extracted.
const logPath = process.argv[2];
assert.ok(logPath, 'Usage: node .github/scripts/check-ignore-paths.mjs <renovate-json-log>');

const extracted = fs
  .readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line))
  .find((record) => record.msg === 'Extracted dependencies');
assert.ok(
  extracted,
  'The Renovate log has no "Extracted dependencies" record, so the check cannot tell which files Renovate scanned. ' +
    'Look in the Renovate output printed above for the error that stopped the run before extraction.'
);

const scanned = Object.values(extracted.packageFiles)
  .flat()
  .map((packageFile) => packageFile.packageFile)
  .sort();

// renovate.json is the consumer config the workflow writes; its github> preset reference is a dependency too.
assert.deepEqual(
  scanned,
  ['Dockerfile', 'renovate.json', 'test/integration/go.mod', 'tests/robot/requirements.txt'],
  'Renovate scanned a different set of files in tests/fixtures/ignore-paths than expected. The check keeps ' +
    'dependency files under test/ and tests/ in Renovate scope and fixture directories out of it. Fix ignorePaths ' +
    'in org-inherited-config.json, or, where the set is meant to change, change the fixture tree and the expected ' +
    'list in .github/scripts/check-ignore-paths.mjs together.'
);

console.log(`Renovate scanned ${scanned.length} expected package files: ${scanned.join(', ')}.`);
