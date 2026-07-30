import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ONBOARDING_STATE_DIR } from './config.mjs';
import { resolveType, validate as validateWorkerType } from './worker-types.mjs';
import { resolveOverseasRole } from './role-catalog.mjs';

export const ONBOARDING_VERSION = 2;

export const PHASES = [
  'intake_validated',
  'awaiting_copy_approval',
  'ready_to_send',
  'packet_active',
  'awaiting_worker_signature',
  'awaiting_countersignature',
  'awaiting_executed_copy_delivery',
  'awaiting_filing',
  'awaiting_manual_gates',
  'complete',
];

export const GATES = {
  w2_local: [
    'i9_identity_review',
    'w4_received',
    'de4_received',
    'pay_election_recorded',
    'emergency_contact_received',
    'payroll_enrollment_confirmed',
    'de34_filed',
    'payment_and_tax_review_complete',
    'actual_safety_training_completed',
    'wc_5552_bound',
    'wage_notice_wc_fields_verified',
  ],
  overseas_contractor: [
    'w8ben_instructions_delivered',
    'w8ben_received',
    'w8ben_human_reviewed',
    'w8ben_restricted_filing_confirmed',
    'role_scope_approved',
    'role_expectations_delivered',
    'payment_rail_verified',
    'payment_and_tax_review_complete',
  ],
};

const W2_ROLES = new Set(['Roofer', 'Foreman']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const FORBIDDEN_KEY = /(?:^|_)(?:link|url|slug|token|secret|password|cookie|api_?key)(?:$|_)|(?:Link|Url|URL|Slug|Token|Secret|Password|Cookie|ApiKey)/;
const BEARER_VALUE = /https?:\/\/\S+\/(?:s|submitters?|submissions?)\/[^\s]+/i;

function validIsoDate(value) {
  if (!ISO_DATE.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requiredText(value, label, problems) {
  if (typeof value !== 'string' || !value.trim()) problems.push(`${label} is required`);
  return typeof value === 'string' ? value.trim() : value;
}

function positiveMoney(value, label, problems) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) problems.push(`${label} must be a positive number`);
  return amount;
}

export function validateIntake(type, raw) {
  resolveType(type);
  const intake = { ...raw };
  const problems = [];
  let roleBinding;
  intake.name = requiredText(intake.name, 'name', problems);
  intake.phone = requiredText(intake.phone, 'phone', problems);
  intake.role = requiredText(intake.role, 'role', problems);
  intake.startDate = requiredText(intake.startDate, 'startDate', problems);
  if (intake.phone && !E164.test(intake.phone)) problems.push('phone must use E.164 format');
  if (intake.startDate && !validIsoDate(intake.startDate)) problems.push('startDate must be a valid YYYY-MM-DD date');

  if (type === 'w2_local') {
    intake.language = intake.language || 'en';
    if (!['en', 'es'].includes(intake.language)) problems.push('W-2 language must be en or es');
    if (intake.phone && !intake.phone.startsWith('+1')) problems.push('w2_local phone must start with +1');
    if (!W2_ROLES.has(intake.role)) problems.push('W-2 role must be Roofer or Foreman');
    intake.baseHourlyRate = positiveMoney(intake.baseHourlyRate, 'baseHourlyRate', problems);
    intake.productionBonusRate = positiveMoney(intake.productionBonusRate, 'productionBonusRate', problems);
    if (intake.sickLeaveMethod !== 'accrual') problems.push('sickLeaveMethod must be accrual');
    if (intake.payday !== 'Friday') problems.push('payday must be Friday');
  } else {
    intake.language = intake.language || 'en';
    intake.country = requiredText(intake.country, 'country', problems);
    if (intake.language !== 'en') problems.push('overseas contractor packet currently supports English only');
    if (intake.phone?.startsWith('+1')) problems.push('overseas_contractor phone must not start with +1');
    if (intake.role) {
      try {
        const resolved = resolveOverseasRole(
          intake.roleKey || intake.role,
          intake.roleExpectationsVersion,
        );
        intake.roleKey = resolved.roleKey;
        intake.role = resolved.displayName;
        intake.roleExpectationsVersion = resolved.version;
        roleBinding = {
          roleKey: resolved.roleKey,
          displayName: resolved.displayName,
          version: resolved.version,
          artifact: resolved.artifact,
          sha256: resolved.sha256,
        };
      } catch (error) {
        problems.push(error.message);
      }
    }
    intake.rateProbation = positiveMoney(intake.rateProbation, 'rateProbation', problems);
    const months = Number(intake.probationMonths);
    if (!Number.isInteger(months) || months <= 0) problems.push('probationMonths must be a positive integer');
    intake.probationMonths = months;
    intake.rate = positiveMoney(intake.rate, 'rate', problems);
    if (intake.currency !== 'USD') problems.push('currency must be USD because the agreement states US dollars');
    if (intake.cadence !== 'twice-monthly') {
      problems.push('cadence must be twice-monthly because the agreement states the 15th and last day');
    }
    if (intake.paymentRail !== 'Mercury') problems.push('paymentRail must be Mercury because the agreement names it');
  }

  const workerCheck = validateWorkerType({ type, ...intake });
  problems.push(...workerCheck.problems.filter((problem) => !problems.includes(problem)));
  return { ok: problems.length === 0, problems, intake, roleBinding };
}

function assertSafeValue(value, path = 'record') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeValue(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && BEARER_VALUE.test(value)) {
      throw new Error(`${path} contains a private signing URL`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`${path}.${key} is not allowed in onboarding state`);
    assertSafeValue(child, `${path}.${key}`);
  }
}

function emptyGates(type) {
  return Object.fromEntries(GATES[type].map((name) => [name, { status: 'pending' }]));
}

export function createRecord(type, rawIntake, { now = new Date().toISOString(), id = randomUUID() } = {}) {
  const checked = validateIntake(type, rawIntake);
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  const record = {
    version: ONBOARDING_VERSION,
    onboardingId: id,
    type,
    person: {
      name: checked.intake.name,
      phone: checked.intake.phone,
      language: checked.intake.language,
      ...(checked.intake.email ? { email: checked.intake.email } : {}),
    },
    intake: checked.intake,
    ...(type === 'overseas_contractor' ? { roleBinding: checked.roleBinding } : {}),
    phase: 'awaiting_copy_approval',
    gates: emptyGates(type),
    documents: [],
    deliveries: {},
    audit: [{ at: now, actor: 'operator', action: 'created', details: { type } }],
    createdAt: now,
    updatedAt: now,
  };
  assertRecord(record);
  return record;
}

export function rebindOverseasRole(record, role, version, {
  actor = 'operator',
  now = new Date().toISOString(),
} = {}) {
  if (record.type !== 'overseas_contractor') {
    throw new Error('role rebinding is only valid for overseas_contractor');
  }
  if (record.packetId || !['awaiting_copy_approval', 'ready_to_send'].includes(record.phase)) {
    throw new Error('an overseas role can only be rebound before the packet starts');
  }
  const resolved = resolveOverseasRole(role, version);
  const previous = record.roleBinding;
  record.intake.roleKey = resolved.roleKey;
  record.intake.role = resolved.displayName;
  record.intake.roleExpectationsVersion = resolved.version;
  record.roleBinding = {
    roleKey: resolved.roleKey,
    displayName: resolved.displayName,
    version: resolved.version,
    artifact: resolved.artifact,
    sha256: resolved.sha256,
  };
  delete record.copyApproval;
  record.phase = 'awaiting_copy_approval';
  record.updatedAt = now;
  record.audit.push({
    at: now,
    actor,
    action: 'role-rebound',
    details: {
      fromRoleKey: previous.roleKey,
      fromVersion: previous.version,
      toRoleKey: resolved.roleKey,
      toVersion: resolved.version,
    },
  });
  return assertRecord(record);
}

export function migrateRecord(record, now = new Date().toISOString()) {
  if (record?.version === ONBOARDING_VERSION) return record;
  if (record?.version !== 1) throw new Error('unsupported onboarding record version');
  const migrated = structuredClone(record);
  if (migrated.type === 'overseas_contractor') {
    if (migrated.intake?.role !== 'Roofing Project Coordinator' ||
      !['roofing-project-coordinator-v1', '1.0'].includes(migrated.intake?.roleExpectationsVersion)) {
      throw new Error('legacy overseas onboarding role cannot be migrated automatically; select an explicit catalog role and version');
    }
    const resolved = resolveOverseasRole('roofing-project-coordinator', '1.0', { allowInactive: true });
    migrated.intake.roleKey = resolved.roleKey;
    migrated.intake.role = resolved.displayName;
    migrated.intake.roleExpectationsVersion = resolved.version;
    migrated.roleBinding = {
      roleKey: resolved.roleKey,
      displayName: resolved.displayName,
      version: resolved.version,
      artifact: resolved.artifact,
      sha256: resolved.sha256,
    };
  }
  migrated.gates ||= {};
  for (const gate of GATES[migrated.type] || []) migrated.gates[gate] ||= { status: 'pending' };
  migrated.version = ONBOARDING_VERSION;
  migrated.updatedAt = now;
  migrated.audit ||= [];
  migrated.audit.push({
    at: now,
    actor: 'system',
    action: 'record-migrated',
    details: { fromVersion: 1, toVersion: ONBOARDING_VERSION },
  });
  return assertRecord(migrated);
}

export function assertRecord(record) {
  if (record?.version !== ONBOARDING_VERSION) throw new Error('unsupported onboarding record version');
  if (!record.onboardingId) throw new Error('onboardingId is required');
  resolveType(record.type);
  if (record.type === 'overseas_contractor') {
    const binding = record.roleBinding;
    for (const key of ['roleKey', 'displayName', 'version', 'artifact', 'sha256']) {
      if (typeof binding?.[key] !== 'string' || !binding[key]) {
        throw new Error(`overseas contractor role binding ${key} is required`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(binding.sha256)) {
      throw new Error('overseas contractor role binding sha256 is invalid');
    }
  }
  if (!PHASES.includes(record.phase)) throw new Error(`unknown onboarding phase ${record.phase}`);
  const allowedGates = new Set(GATES[record.type]);
  for (const [name, gate] of Object.entries(record.gates || {})) {
    if (!allowedGates.has(name)) throw new Error(`gate ${name} is not valid for ${record.type}`);
    if (!['pending', 'satisfied', 'blocked'].includes(gate.status)) {
      throw new Error(`gate ${name} has invalid status ${gate.status}`);
    }
  }
  assertSafeValue(record);
  return record;
}

export function approveCopy(record, approvalReference, copyHash, actor = 'operator', now = new Date().toISOString()) {
  if (record.phase === 'complete') throw new Error('completed onboarding copy cannot be changed');
  if (!record.copyApproval && record.phase !== 'awaiting_copy_approval') {
    throw new Error('copy can only be approved after intake validation');
  }
  if (!approvalReference?.trim()) throw new Error('approval reference is required');
  if (!/^[a-f0-9]{64}$/.test(copyHash || '')) throw new Error('approved copy hash is required');
  if (BEARER_VALUE.test(approvalReference)) throw new Error('approval reference cannot contain a signing URL');
  const firstApproval = !record.copyApproval;
  record.copyApproval = {
    reference: approvalReference.trim(),
    copyHash,
    approvedBy: actor,
    approvedAt: now,
  };
  if (firstApproval) record.phase = 'ready_to_send';
  record.updatedAt = now;
  record.audit.push({
    at: now,
    actor,
    action: firstApproval ? 'copy-approved' : 'copy-reapproved',
    details: { reference: approvalReference.trim() },
  });
  return assertRecord(record);
}

export function recordGate(record, gateName, evidenceReference, {
  actor = 'operator',
  now = new Date().toISOString(),
  status = 'satisfied',
  note,
} = {}) {
  if (!GATES[record.type].includes(gateName)) throw new Error(`gate ${gateName} is not valid for ${record.type}`);
  if (!['satisfied', 'blocked'].includes(status)) throw new Error('gate status must be satisfied or blocked');
  if (!evidenceReference?.trim()) throw new Error('evidence reference is required');
  if (BEARER_VALUE.test(evidenceReference)) throw new Error('evidence reference cannot contain a signing URL');
  record.gates[gateName] = {
    status,
    evidenceRef: evidenceReference.trim(),
    verifiedBy: actor,
    verifiedAt: now,
    ...(note ? { note } : {}),
  };
  record.updatedAt = now;
  record.audit.push({ at: now, actor, action: 'gate-recorded', details: { gate: gateName, status } });
  return assertRecord(record);
}

function deadlineStatus(record) {
  if (record.type === 'overseas_contractor') {
    return [{ gate: 'w8ben_human_reviewed', due: 'before first payment' }];
  }
  const start = new Date(`${record.intake.startDate}T00:00:00Z`);
  const de34 = new Date(start);
  de34.setUTCDate(de34.getUTCDate() + 20);
  return [
    { gate: 'i9_identity_review', due: 'no later than the third business day after work starts' },
    { gate: 'w4_received', due: 'before first payroll' },
    { gate: 'de4_received', due: 'before first payroll' },
    { gate: 'de34_filed', due: de34.toISOString().slice(0, 10) },
  ];
}

function prohibitedActions(type) {
  return type === 'w2_local'
    ? ['W-9', '1099', 'Mercury recipient', 'vendor bill', 'independent contractor agreement']
    : ['I-9', 'W-4', 'DE 4', 'DE 34', 'California pamphlets', 'workers compensation', 'payroll'];
}

export function deriveStatus(record) {
  assertRecord(record);
  const pendingGates = GATES[record.type].filter((name) => record.gates[name]?.status !== 'satisfied');
  const blockedGates = pendingGates.filter((name) => record.gates[name]?.status === 'blocked');
  const documentsComplete = record.documents.length > 0 && record.documents.every((document) =>
    document.workerSignedAt && (!document.requiresCountersign || document.countersignedAt) &&
    document.copyDeliveredAt && document.filedAt);
  const manualReady = pendingGates.length === 0;
  const complete = documentsComplete && manualReady;
  const nextAction = nextOperatorAction(record, pendingGates, documentsComplete);
  return {
    onboardingId: record.onboardingId,
    type: record.type,
    phase: complete ? 'complete' : record.phase,
    pendingGates,
    blockedGates,
    deadlines: deadlineStatus(record),
    prohibited: prohibitedActions(record.type),
    nextAction,
    documentsComplete,
    complete,
    roofReady: record.type === 'w2_local' && complete && record.gates.wc_5552_bound.status === 'satisfied',
    paymentAuthorized: record.type === 'overseas_contractor' && complete &&
      record.gates.payment_rail_verified.status === 'satisfied' &&
      record.gates.payment_and_tax_review_complete.status === 'satisfied',
  };
}

function nextOperatorAction(record, pendingGates, documentsComplete) {
  if (record.phase === 'awaiting_copy_approval') return 'approve the exact outbound copy';
  if (record.phase === 'ready_to_send') return 'start the approved onboarding packet';
  if (record.phase === 'awaiting_worker_signature') return 'wait for the current signer';
  if (record.phase === 'awaiting_countersignature') return 'release the countersign action to Hamilton';
  if (record.phase === 'awaiting_executed_copy_delivery') return 'deliver the executed copy';
  if (record.phase === 'awaiting_filing') return 'file completed documents';
  if (!documentsComplete) return 'advance the document lifecycle';
  if (pendingGates.length) return `record required evidence for ${pendingGates[0]}`;
  return 'onboarding complete';
}

function ensureDirectory() {
  mkdirSync(ONBOARDING_STATE_DIR, { recursive: true, mode: 0o700 });
}

export const recordPath = (onboardingId) => join(ONBOARDING_STATE_DIR, `${onboardingId}.json`);
const lockPath = (onboardingId) => join(ONBOARDING_STATE_DIR, `${onboardingId}.lock`);

export function saveRecord(record) {
  assertRecord(record);
  ensureDirectory();
  const path = recordPath(record.onboardingId);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

export function loadRecord(onboardingId) {
  const path = recordPath(onboardingId);
  if (!existsSync(path)) throw new Error(`no onboarding record found for ${onboardingId}`);
  return migrateRecord(JSON.parse(readFileSync(path, 'utf8')));
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function staleLock(path) {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (Number.isInteger(owner.pid)) return !processIsRunning(owner.pid);
  } catch {
    // Fall through to a conservative age check for malformed legacy locks.
  }
  try {
    return Date.now() - statSync(path).mtimeMs > 6 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export async function withRecordLock(onboardingId, operation) {
  ensureDirectory();
  const path = lockPath(onboardingId);
  const token = randomUUID();
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
      break;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      descriptor = undefined;
      if (error.code === 'EEXIST' && attempt === 0 && staleLock(path)) {
        unlinkSync(path);
        continue;
      }
      if (error.code === 'EEXIST') throw new Error(`onboarding ${onboardingId} is already being updated`);
      throw error;
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    let owner;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); }
    catch { owner = null; }
    if (owner?.token === token) unlinkSync(path);
  }
}
