import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRoleCatalog,
  resolveOverseasRole,
  resolveRoleBinding,
} from '../pipeline/role-catalog.mjs';

function artifact({
  roleKey,
  displayName,
  version,
  approved = true,
  classification = 'overseas_contractor',
  language = 'en',
}) {
  return `# ${displayName}\n\n` +
    `**Role key:** \`${roleKey}\`\n` +
    `**Display name:** \`${displayName}\`\n` +
    `**Artifact version:** \`${version}\`\n` +
    `**Classification:** \`${classification}\`\n` +
    `**Language:** \`${language}\`\n` +
    `**Status:** ${approved ? 'owner-approved for release' : 'draft, not approved for release'}\n` +
    (approved
      ? `**Approved by:** Alex Li, President\n**Approved on:** 2026-07-29\n`
      : '');
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hamilton-role-catalog-'));
  const roles = [
    {
      roleKey: 'project-coordinator',
      displayName: 'Project Coordinator',
      active: true,
      activeVersion: '2.0',
      versions: [
        { version: '1.0', approved: true },
        { version: '2.0', approved: true },
      ],
    },
    {
      roleKey: 'estimator',
      displayName: 'Estimator',
      active: true,
      activeVersion: '1.0',
      versions: [{ version: '1.0', approved: false }],
    },
  ];
  for (const role of roles) {
    mkdirSync(join(root, role.roleKey), { recursive: true });
    for (const version of role.versions) {
      version.artifact = `${role.roleKey}/${version.version}.md`;
      const content = artifact({ ...role, ...version });
      version.sha256 = digest(content);
      writeFileSync(join(root, version.artifact), content);
      delete version.approved;
    }
  }
  const catalog = {
    version: 1,
    roles: roles.map((role) => ({
      roleKey: role.roleKey,
      displayName: role.displayName,
      classification: 'overseas_contractor',
      language: 'en',
      active: role.active,
      activeVersion: role.activeVersion,
      versions: role.versions,
    })),
  };
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify(catalog));
  return { root, catalog, catalogPath, options: { catalogPath, roleRoot: root } };
}

function rewrite(value) {
  writeFileSync(value.catalogPath, JSON.stringify(value.catalog));
}

test('resolves multiple roles, defaults new records, and pins explicit historical versions', () => {
  const value = fixture();
  const current = resolveOverseasRole('Project Coordinator', undefined, value.options);
  assert.equal(current.roleKey, 'project-coordinator');
  assert.equal(current.version, '2.0');
  assert.equal(current.approved, true);

  const historical = resolveOverseasRole('project-coordinator', '1.0', value.options);
  assert.equal(historical.version, '1.0');
  const binding = {
    roleKey: historical.roleKey,
    displayName: historical.displayName,
    version: historical.version,
    artifact: historical.artifact,
    sha256: historical.sha256,
  };

  value.catalog.roles[0].activeVersion = '2.0';
  rewrite(value);
  assert.equal(resolveRoleBinding(binding, value.options).version, '1.0');

  const draft = resolveOverseasRole('estimator', undefined, value.options);
  assert.equal(draft.approved, false);
});

test('retired roles block new records without invalidating pinned records', () => {
  const value = fixture();
  const selected = resolveOverseasRole('estimator', '1.0', value.options);
  const binding = {
    roleKey: selected.roleKey,
    displayName: selected.displayName,
    version: selected.version,
    artifact: selected.artifact,
    sha256: selected.sha256,
  };
  value.catalog.roles[1].active = false;
  rewrite(value);
  assert.throws(() => resolveOverseasRole('estimator', undefined, value.options), /inactive/);
  assert.equal(resolveRoleBinding(binding, value.options).active, false);
});

test('rejects malformed catalogs, unknown roles, unsafe paths, and changed artifacts', () => {
  const cases = [
    ['unknown role', (value) => assert.throws(
      () => resolveOverseasRole('unknown-role', undefined, value.options), /unsupported/)],
    ['duplicate key', (value) => {
      value.catalog.roles.push(structuredClone(value.catalog.roles[0]));
      rewrite(value);
      assert.throws(() => loadRoleCatalog(value.options), /duplicate overseas role key/);
    }],
    ['unpublished version', (value) => assert.throws(
      () => resolveOverseasRole('estimator', '9.0', value.options), /not published/)],
    ['digest mismatch', (value) => {
      value.catalog.roles[0].versions[0].sha256 = 'a'.repeat(64);
      rewrite(value);
      assert.throws(() => loadRoleCatalog(value.options), /digest does not match/);
    }],
    ['metadata mismatch', (value) => {
      const version = value.catalog.roles[0].versions[0];
      const content = artifact({
        roleKey: 'wrong-role',
        displayName: 'Project Coordinator',
        version: '1.0',
      });
      writeFileSync(join(value.root, version.artifact), content);
      version.sha256 = digest(content);
      rewrite(value);
      assert.throws(() => loadRoleCatalog(value.options), /metadata mismatch: role key/);
    }],
    ['traversal', (value) => {
      value.catalog.roles[0].versions[0].artifact = '../outside.md';
      rewrite(value);
      assert.throws(() => loadRoleCatalog(value.options), /unsafe overseas role artifact path/);
    }],
    ['absolute path', (value) => {
      value.catalog.roles[0].versions[0].artifact = join(value.root, 'outside.md');
      rewrite(value);
      assert.throws(() => loadRoleCatalog(value.options), /unsafe overseas role artifact path/);
    }],
  ];
  for (const [label, assertion] of cases) assertion(fixture(), label);
});

test('rejects an artifact reached through a directory junction outside the role root', () => {
  const value = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'hamilton-role-outside-'));
  const target = join(outside, 'escaped-role');
  mkdirSync(target);
  const content = artifact({
    roleKey: 'escaped-role',
    displayName: 'Escaped Role',
    version: '1.0',
  });
  writeFileSync(join(target, '1.0.md'), content);
  symlinkSync(target, join(value.root, 'escaped-role'), 'junction');
  value.catalog.roles.push({
    roleKey: 'escaped-role',
    displayName: 'Escaped Role',
    classification: 'overseas_contractor',
    language: 'en',
    active: true,
    activeVersion: '1.0',
    versions: [{
      version: '1.0',
      artifact: 'escaped-role/1.0.md',
      sha256: digest(content),
    }],
  });
  rewrite(value);
  assert.throws(() => loadRoleCatalog(value.options), /escapes the canonical root/);
});

test('only exact owner approval metadata releases a role scope', () => {
  const value = fixture();
  const estimator = resolveOverseasRole('estimator', undefined, value.options);
  assert.equal(estimator.approved, false);

  const role = value.catalog.roles[1];
  const version = role.versions[0];
  const content = artifact({
    roleKey: role.roleKey,
    displayName: role.displayName,
    version: version.version,
    approved: true,
  });
  writeFileSync(join(value.root, version.artifact), content);
  version.sha256 = digest(content);
  rewrite(value);
  const approved = resolveOverseasRole('estimator', undefined, value.options);
  assert.equal(approved.approved, true);
  assert.deepEqual(approved.approval, {
    approvedBy: 'Alex Li, President',
    approvedOn: '2026-07-29',
  });
});
