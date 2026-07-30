import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'hamilton-onboarding-multi-role-'));
const roleRoot = join(scratch, 'roles');
const catalogPath = join(scratch, 'catalog.json');
process.env.HAMILTON_OVERSEAS_ROLE_ROOT = roleRoot;
process.env.HAMILTON_OVERSEAS_ROLE_CATALOG_PATH = catalogPath;
process.env.HAMILTON_ONBOARDING_STATE_DIR = join(scratch, 'state');
const secretPath = join(scratch, 'docuseal.json');
writeFileSync(secretPath, JSON.stringify({
  url: 'https://docuseal.test',
  publicUrl: 'https://sign.test',
  apiKey: 'test',
}));
process.env.DOCUSEAL_SECRET_PATH = secretPath;

const roles = [
  { roleKey: 'project-coordinator', displayName: 'Project Coordinator', version: '2.0' },
  { roleKey: 'estimator', displayName: 'Estimator', version: '1.0' },
];
const entries = [];
for (const role of roles) {
  mkdirSync(join(roleRoot, role.roleKey), { recursive: true });
  const content = `# ${role.displayName}\n\n` +
    `**Role key:** \`${role.roleKey}\`\n` +
    `**Display name:** \`${role.displayName}\`\n` +
    `**Artifact version:** \`${role.version}\`\n` +
    `**Classification:** \`overseas_contractor\`\n` +
    `**Language:** \`en\`\n` +
    `**Status:** owner-approved for release\n` +
    `**Approved by:** Alex Li, President\n` +
    `**Approved on:** 2026-07-29\n`;
  const artifact = `${role.roleKey}/${role.version}.md`;
  writeFileSync(join(roleRoot, artifact), content);
  entries.push({
    roleKey: role.roleKey,
    displayName: role.displayName,
    classification: 'overseas_contractor',
    language: 'en',
    active: true,
    activeVersion: role.version,
    versions: [{
      version: role.version,
      artifact,
      sha256: createHash('sha256').update(content).digest('hex'),
    }],
  });
}
writeFileSync(catalogPath, JSON.stringify({ version: 1, roles: entries }));

const { approveCopy, createRecord, rebindOverseasRole } = await import('../pipeline/onboarding-state.mjs');
const { contractorRoleScopeRelease } = await import('../pipeline/onboarding.mjs');

function intake(role, overrides = {}) {
  return {
    name: `ZZ TEST ${role}`,
    phone: '+639171234567',
    language: 'en',
    role,
    country: 'Philippines',
    startDate: '2026-08-01',
    rateProbation: 900,
    probationMonths: 3,
    rate: 1200,
    currency: 'USD',
    cadence: 'twice-monthly',
    paymentRail: 'Mercury',
    ...overrides,
  };
}

test('creates different overseas roles from the catalog without code-specific role branches', () => {
  const coordinator = createRecord('overseas_contractor', intake('Project Coordinator'));
  assert.deepEqual(coordinator.roleBinding, {
    roleKey: 'project-coordinator',
    displayName: 'Project Coordinator',
    version: '2.0',
    artifact: 'project-coordinator/2.0.md',
    sha256: entries[0].versions[0].sha256,
  });
  assert.equal(contractorRoleScopeRelease(coordinator).approved, true);

  const estimator = createRecord('overseas_contractor', intake('estimator'));
  assert.equal(estimator.intake.role, 'Estimator');
  assert.equal(estimator.intake.roleKey, 'estimator');
  assert.equal(estimator.intake.roleExpectationsVersion, '1.0');
  assert.equal(estimator.roleBinding.version, '1.0');
  assert.equal(contractorRoleScopeRelease(estimator).approved, true);
});



test('rebinds a draft record to another configured role and invalidates copy approval', () => {
  const record = createRecord('overseas_contractor', intake('Project Coordinator'));
  approveCopy(record, 'ZZ TEST copy approval', 'a'.repeat(64));
  assert.equal(record.phase, 'ready_to_send');
  rebindOverseasRole(record, 'estimator', undefined, {
    actor: 'ZZ TEST operator',
    now: '2026-07-29T14:00:00.000Z',
  });
  assert.equal(record.roleBinding.roleKey, 'estimator');
  assert.equal(record.intake.role, 'Estimator');
  assert.equal(record.phase, 'awaiting_copy_approval');
  assert.equal(record.copyApproval, undefined);
  assert.equal(record.audit.at(-1).action, 'role-rebound');

  record.packetId = 'zz-test-packet';
  assert.throws(() => rebindOverseasRole(record, 'project-coordinator'), /before the packet starts/);
});

test('rejects an unsupported role instead of selecting another catalog role', () => {
  assert.throws(
    () => createRecord('overseas_contractor', intake('ZZ TEST Unsupported')),
    /unsupported overseas contractor role/,
  );
});
