import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  OVERSEAS_ROLE_CATALOG_PATH,
  OVERSEAS_ROLE_ROOT,
} from './config.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const ROLE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+(?:\.\d+)?$/;
const ARTIFACT_PATH = /^[a-z0-9]+(?:-[a-z0-9]+)*\/\d+\.\d+(?:\.\d+)?\.md$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported keys: ${unknown.join(', ')}`);
}

function validDate(value) {
  if (!ISO_DATE.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactFile(relativePath, root) {
  if (!ARTIFACT_PATH.test(relativePath) || isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error(`unsafe overseas role artifact path: ${relativePath}`);
  }
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, relativePath);
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`overseas role artifact cannot be a symbolic link: ${relativePath}`);
  }
  const actual = realpathSync(candidate);
  const fromRoot = relative(rootReal, actual);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`overseas role artifact escapes the canonical root: ${relativePath}`);
  }
  if (!statSync(actual).isFile()) throw new Error(`overseas role artifact is not a regular file: ${relativePath}`);
  return actual;
}

function artifactMetadata(content) {
  const fields = new Map();
  for (const match of content.matchAll(/^\*\*([A-Za-z ]+):\*\*\s*(?:`([^`]+)`|([^\r\n]+))\s*$/gmi)) {
    fields.set(match[1].toLowerCase(), (match[2] || match[3]).trim());
  }
  const value = (name) => fields.get(name.toLowerCase()) || null;
  const approvalDate = value('Approved on');
  return {
    roleKey: value('Role key'),
    displayName: value('Display name'),
    version: value('Artifact version'),
    classification: value('Classification'),
    language: value('Language'),
    status: value('Status'),
    approvedBy: value('Approved by'),
    approvedOn: approvalDate,
    approved: /^owner-approved for release$/i.test(value('Status') || '') &&
      value('Approved by') === 'Alex Li, President' && validDate(approvalDate),
  };
}

function validateVersion(raw, role, seenVersions, root) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`role ${role.roleKey} has an invalid version entry`);
  exactKeys(raw, ['version', 'artifact', 'sha256'], `role ${role.roleKey} version`);
  const version = requiredString(raw.version, `role ${role.roleKey} version`);
  if (!VERSION.test(version)) throw new Error(`role ${role.roleKey} has an invalid version ${version}`);
  if (seenVersions.has(version)) throw new Error(`role ${role.roleKey} duplicates version ${version}`);
  seenVersions.add(version);
  const artifact = requiredString(raw.artifact, `role ${role.roleKey} artifact`);
  const expectedHash = requiredString(raw.sha256, `role ${role.roleKey} sha256`);
  if (!SHA256.test(expectedHash)) throw new Error(`role ${role.roleKey} version ${version} has an invalid sha256`);
  const path = artifactFile(artifact, root);
  const content = readFileSync(path, 'utf8');
  const actualHash = sha256(content);
  if (actualHash !== expectedHash) throw new Error(`role ${role.roleKey} version ${version} artifact digest does not match the catalog`);
  const metadata = artifactMetadata(content);
  const mismatches = [
    ['role key', metadata.roleKey, role.roleKey],
    ['display name', metadata.displayName, role.displayName],
    ['artifact version', metadata.version, version],
    ['classification', metadata.classification, 'overseas_contractor'],
    ['language', metadata.language, 'en'],
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length) {
    throw new Error(`role ${role.roleKey} version ${version} artifact metadata mismatch: ${mismatches.map(([name]) => name).join(', ')}`);
  }
  return {
    version,
    artifact,
    sha256: actualHash,
    approved: metadata.approved,
    approval: metadata.approved ? {
      approvedBy: metadata.approvedBy,
      approvedOn: metadata.approvedOn,
    } : null,
  };
}

export function loadRoleCatalog({
  catalogPath = OVERSEAS_ROLE_CATALOG_PATH,
  roleRoot = OVERSEAS_ROLE_ROOT,
} = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read overseas role catalog at ${catalogPath}: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('overseas role catalog must be an object');
  exactKeys(raw, ['version', 'roles'], 'overseas role catalog');
  if (raw.version !== 1) throw new Error(`unsupported overseas role catalog version ${raw.version}`);
  if (!Array.isArray(raw.roles) || !raw.roles.length) throw new Error('overseas role catalog requires at least one role');
  const seenKeys = new Set();
  const seenNames = new Set();
  const roles = raw.roles.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid overseas role catalog entry');
    exactKeys(entry, [
      'roleKey', 'displayName', 'classification', 'language', 'active', 'activeVersion', 'versions',
    ], 'overseas role');
    const role = {
      roleKey: requiredString(entry.roleKey, 'roleKey'),
      displayName: requiredString(entry.displayName, 'displayName'),
      classification: entry.classification,
      language: entry.language,
      active: entry.active,
      activeVersion: requiredString(entry.activeVersion, 'activeVersion'),
    };
    if (!ROLE_KEY.test(role.roleKey)) throw new Error(`invalid overseas role key ${role.roleKey}`);
    if (seenKeys.has(role.roleKey)) throw new Error(`duplicate overseas role key ${role.roleKey}`);
    if (seenNames.has(role.displayName)) throw new Error(`duplicate overseas role display name ${role.displayName}`);
    seenKeys.add(role.roleKey);
    seenNames.add(role.displayName);
    if (role.classification !== 'overseas_contractor') throw new Error(`role ${role.roleKey} must use overseas_contractor classification`);
    if (role.language !== 'en') throw new Error(`role ${role.roleKey} must use English until another language is explicitly supported`);
    if (typeof role.active !== 'boolean') throw new Error(`role ${role.roleKey} active must be boolean`);
    if (!Array.isArray(entry.versions) || !entry.versions.length) throw new Error(`role ${role.roleKey} requires versions`);
    const seenVersions = new Set();
    role.versions = entry.versions.map((version) => validateVersion(version, role, seenVersions, roleRoot));
    if (!role.versions.some((version) => version.version === role.activeVersion)) {
      throw new Error(`role ${role.roleKey} activeVersion ${role.activeVersion} is not published`);
    }
    return role;
  });
  return { version: 1, roles };
}

function matchRole(catalog, input) {
  const wanted = requiredString(input, 'overseas contractor role');
  return catalog.roles.find((role) => role.roleKey === wanted || role.displayName === wanted);
}

export function resolveOverseasRole(input, requestedVersion, options = {}) {
  const catalog = loadRoleCatalog(options);
  const role = matchRole(catalog, input);
  if (!role) throw new Error(`unsupported overseas contractor role ${input}`);
  if (!role.active && !options.allowInactive) throw new Error(`overseas contractor role ${role.displayName} is inactive`);
  const versionName = requestedVersion || role.activeVersion;
  const version = role.versions.find((entry) => entry.version === versionName);
  if (!version) throw new Error(`role ${role.displayName} version ${versionName} is not published`);
  return {
    roleKey: role.roleKey,
    displayName: role.displayName,
    language: role.language,
    version: version.version,
    artifact: version.artifact,
    sha256: version.sha256,
    approved: version.approved,
    approval: version.approval,
    active: role.active,
  };
}

export function resolveRoleBinding(binding, options = {}) {
  if (!binding || typeof binding !== 'object') throw new Error('overseas contractor role binding is required');
  const resolved = resolveOverseasRole(binding.roleKey, binding.version, {
    ...options,
    allowInactive: true,
  });
  for (const key of ['displayName', 'artifact', 'sha256']) {
    if (binding[key] !== resolved[key]) throw new Error(`bound overseas role ${key} no longer matches the canonical catalog`);
  }
  return resolved;
}

const IS_MAIN = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (IS_MAIN) {
  try {
    if (process.argv[2] !== 'list') throw new Error('usage: node pipeline/role-catalog.mjs list');
    const catalog = loadRoleCatalog();
    console.log(JSON.stringify(catalog.roles.map((role) => ({
      roleKey: role.roleKey,
      displayName: role.displayName,
      active: role.active,
      activeVersion: role.activeVersion,
      versions: role.versions.map((version) => ({
        version: version.version,
        approved: version.approved,
        sha256: version.sha256,
      })),
    })), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
