import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'hamilton-onboarding-zz-test-'));
process.env.HAMILTON_ONBOARDING_STATE_DIR = join(scratch, 'onboarding-state');

const workerTypes = await import('../pipeline/worker-types.mjs');
const state = await import('../pipeline/onboarding-state.mjs');
const { bucketFor } = await import('../pipeline/file-to-drive.mjs');

const w2 = () => ({
  name: 'ZZ TEST W2 Roofer',
  phone: '+16509770001',
  role: 'Roofer',
  startDate: '2026-08-01',
  baseHourlyRate: 16.90,
  productionBonusRate: 14.90,
  sickLeaveMethod: 'accrual',
  payday: 'Friday',
});

const contractor = () => ({
  name: 'ZZ TEST Contractor',
  phone: '+639171234567',
  language: 'en',
  role: 'Roofing Project Coordinator',
  roleExpectationsVersion: '1.0',
  country: 'Philippines',
  startDate: '2026-08-01',
  rateProbation: 900,
  probationMonths: 3,
  rate: 1200,
  currency: 'USD',
  cadence: 'twice-monthly',
  paymentRail: 'Mercury',
});

function validRecord(type) {
  return state.createRecord(type, type === 'w2_local' ? w2() : contractor(), {
    id: `zz-test-${type}`,
    now: '2026-07-29T12:00:00.000Z',
  });
}

function satisfyAllGates(record) {
  for (const gate of state.GATES[record.type]) {
    state.recordGate(record, gate, `ZZ TEST evidence for ${gate}`, {
      actor: 'ZZ TEST operator',
      now: '2026-07-29T12:01:00.000Z',
    });
  }
}

test('accepts valid synthetic W-2 and overseas contractor intake records', () => {
  assert.equal(state.validateIntake('w2_local', w2()).ok, true);
  assert.equal(state.validateIntake('overseas_contractor', contractor()).ok, true);
  assert.equal(workerTypes.validate({ type: 'w2_local', ...w2() }).ok, true);
  assert.equal(workerTypes.validate({ type: 'overseas_contractor', ...contractor() }).ok, true);
});

test('refuses missing and unknown worker classifications', () => {
  assert.throws(() => workerTypes.resolveType(), /worker type is required/);
  assert.throws(() => workerTypes.resolveType('ZZ TEST unknown'), /unknown worker type/);
  assert.throws(() => state.validateIntake('ZZ TEST unknown', w2()), /unknown worker type/);
});

test('enforces W-2 phone, role, start date, rates, payday, and sick-leave constraints', () => {
  const cases = [
    [{ phone: '+639171234567' }, /w2_local phone must start with \+1/],
    [{ role: 'ZZ TEST Coordinator' }, /W-2 role must be Roofer or Foreman/],
    [{ startDate: '08/01/2026' }, /startDate must be a valid YYYY-MM-DD date/],
    [{ startDate: '2026-02-30' }, /startDate must be a valid YYYY-MM-DD date/],
    [{ baseHourlyRate: 0 }, /baseHourlyRate must be a positive number/],
    [{ baseHourlyRate: 17 }, /must match the current signed packet rate of 16\.90/],
    [{ productionBonusRate: 'nope' }, /productionBonusRate must be a positive number/],
    [{ productionBonusRate: 15 }, /must match the current Roofer packet rate of 14\.90/],
    [{ role: 'Foreman', productionBonusRate: 14.90 }, /must match the current Foreman packet rate of 29\.90/],
    [{ payday: 'Monday' }, /payday must be Friday/],
    [{ sickLeaveMethod: 'frontload' }, /sickLeaveMethod must be accrual/],
  ];
  for (const [change, expected] of cases) {
    const result = state.validateIntake('w2_local', { ...w2(), ...change });
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.match(result.problems.join('; '), expected);
  }
});

test('enforces contractor phone, English, scope, commercial, country, rate, and Mercury constraints', () => {
  const cases = [
    [{ phone: '+16509770002' }, /must not start with \+1/],
    [{ language: 'es' }, /supports English only/],
    [{ role: 'ZZ TEST Roofer' }, /unsupported overseas contractor role/],
    [{ roleExpectationsVersion: 'ZZ TEST v0' }, /version ZZ TEST v0 is not published/],
    [{ country: '' }, /country is required/],
    [{ rateProbation: 0 }, /rateProbation must be a positive number/],
    [{ probationMonths: 1.5 }, /probationMonths must be a positive integer/],
    [{ rate: 0 }, /rate must be a positive number/],
    [{ currency: 'PHP' }, /currency must be USD/],
    [{ cadence: 'monthly' }, /cadence must be twice-monthly/],
    [{ paymentRail: 'ZZ TEST Bank' }, /paymentRail must be Mercury/],
  ];
  for (const [change, expected] of cases) {
    const result = state.validateIntake('overseas_contractor', { ...contractor(), ...change });
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.match(result.problems.join('; '), expected);
  }
});

test('requires exact copy approval before the ready-to-send transition', () => {
  const record = validRecord('w2_local');
  assert.throws(() => state.approveCopy(record, '', 'a'.repeat(64)), /approval reference is required/);
  assert.throws(() => state.approveCopy(record, 'ZZ TEST approval', ''), /approved copy hash is required/);
  assert.throws(() => state.approveCopy(record, 'https://sign.test/s/ZZ-TEST', 'a'.repeat(64)), /cannot contain a signing URL/);
  state.approveCopy(record, 'ZZ TEST approved exact WhatsApp copy', 'a'.repeat(64),
    'ZZ TEST owner', '2026-07-29T12:02:00.000Z');
  assert.equal(record.phase, 'ready_to_send');
  assert.deepEqual(record.copyApproval, {
    reference: 'ZZ TEST approved exact WhatsApp copy',
    copyHash: 'a'.repeat(64),
    approvedBy: 'ZZ TEST owner',
    approvedAt: '2026-07-29T12:02:00.000Z',
  });
  record.phase = 'packet_active';
  state.approveCopy(record, 'ZZ TEST reapproved exact WhatsApp copy', 'b'.repeat(64),
    'ZZ TEST owner', '2026-07-29T12:03:00.000Z');
  assert.equal(record.phase, 'packet_active');
  assert.equal(record.copyApproval.copyHash, 'b'.repeat(64));
  assert.equal(record.audit.at(-1).action, 'copy-reapproved');
  record.phase = 'complete';
  assert.throws(() => state.approveCopy(record, 'ZZ TEST late approval', 'c'.repeat(64)),
    /completed onboarding copy cannot be changed/);
});

test('requires evidence for every classification-specific manual gate and rejects cross-type gates', () => {
  for (const type of Object.keys(state.GATES)) {
    const record = validRecord(type);
    for (const gate of state.GATES[type]) {
      state.recordGate(record, gate, `ZZ TEST evidence ${gate}`);
      assert.equal(record.gates[gate].status, 'satisfied');
    }
    const other = type === 'w2_local' ? 'w8ben_received' : 'i9_identity_review';
    assert.throws(() => state.recordGate(record, other, 'ZZ TEST cross-type evidence'), /is not valid/);
  }
});

test('derives roof readiness and contractor payment authorization from completed synthetic records', () => {
  const employee = validRecord('w2_local');
  employee.documents = [{
    key: 'agreement', workerSignedAt: '2026-07-29T12:03:00.000Z',
    requiresCountersign: true, countersignedAt: '2026-07-29T12:04:00.000Z',
    copyDeliveredAt: '2026-07-29T12:05:00.000Z', filedAt: '2026-07-29T12:06:00.000Z',
  }];
  satisfyAllGates(employee);
  const employeeStatus = state.deriveStatus(employee);
  assert.equal(employeeStatus.complete, true);
  assert.equal(employeeStatus.roofReady, true);
  assert.equal(employeeStatus.paymentAuthorized, false);

  const overseas = validRecord('overseas_contractor');
  overseas.documents = [{
    key: 'contractor-agreement', workerSignedAt: '2026-07-29T12:03:00.000Z',
    requiresCountersign: false, copyDeliveredAt: '2026-07-29T12:05:00.000Z',
    filedAt: '2026-07-29T12:06:00.000Z',
  }];
  satisfyAllGates(overseas);
  const contractorStatus = state.deriveStatus(overseas);
  assert.equal(contractorStatus.complete, true);
  assert.equal(contractorStatus.roofReady, false);
  assert.equal(contractorStatus.paymentAuthorized, true);
});

test('rejects signing URLs and signing keys anywhere in persisted onboarding state', () => {
  const record = validRecord('w2_local');
  assert.throws(() => state.assertRecord({ ...record, signingUrl: 'ZZ TEST' }), /signingUrl is not allowed/);
  assert.throws(() => state.assertRecord({ ...record, nested: { api_key: 'ZZ TEST' } }), /api_key is not allowed/);
  assert.throws(() => state.assertRecord({ ...record, note: 'https://sign.test/s/ZZ-TEST' }), /private signing URL/);
});

test('atomically saves and loads synthetic state under the pre-import temporary directory', () => {
  const record = validRecord('overseas_contractor');
  const path = state.saveRecord(record);
  assert.equal(path, join(process.env.HAMILTON_ONBOARDING_STATE_DIR, 'zz-test-overseas_contractor.json'));
  assert.equal(existsSync(path), true);
  assert.deepEqual(state.loadRecord(record.onboardingId), record);
  assert.deepEqual(readdirSync(process.env.HAMILTON_ONBOARDING_STATE_DIR).filter((name) => name.endsWith('.tmp')), []);
});



test('migrates the known v1 contractor role and blocks unknown legacy roles', () => {
  const current = validRecord('overseas_contractor');
  const legacy = structuredClone(current);
  legacy.version = 1;
  legacy.intake.roleExpectationsVersion = 'roofing-project-coordinator-v1';
  delete legacy.intake.roleKey;
  delete legacy.roleBinding;
  const migrated = state.migrateRecord(legacy, '2026-07-29T13:00:00.000Z');
  assert.equal(migrated.version, state.ONBOARDING_VERSION);
  assert.equal(migrated.roleBinding.roleKey, 'roofing-project-coordinator');
  assert.equal(migrated.roleBinding.version, '1.0');
  assert.equal(migrated.audit.at(-1).action, 'record-migrated');

  const unknown = structuredClone(legacy);
  unknown.intake.role = 'ZZ TEST Unknown Role';
  assert.throws(() => state.migrateRecord(unknown), /cannot be migrated automatically/);
});

test('routes contractor agreement and W-8BEN to contractor buckets while W-2 records remain segregated', () => {
  assert.equal(bucketFor('Independent Contractor Agreement'), 'contractor');
  assert.equal(bucketFor('IRS Form W-8BEN'), 'contractor-tax');
  assert.equal(bucketFor('Employment Agreement'), 'personnel');
  assert.equal(bucketFor('Form I-9'), 'i9');
  assert.equal(bucketFor('Safety Training Roster'), 'safety-roster');
});

test('source invariants keep signing links private and classification plans cross-path-free', () => {
  const root = new URL('..', import.meta.url);
  const signingSource = readFileSync(new URL('../pipeline/send-signing-link.mjs', import.meta.url), 'utf8');
  const onboardingSource = readFileSync(new URL('../pipeline/onboarding.mjs', import.meta.url), 'utf8');
  assert.match(signingSource, /hamilton:\s*null/);
  assert.match(signingSource, /\?lang=\$\{l\}/);
  assert.match(signingSource, /send_email:\s*false,\s*send_sms:\s*false/);
  assert.match(onboardingSource, /\['W-9', '1099', 'Mercury recipient', 'vendor bill', 'independent contractor agreement'\]/);
  assert.match(onboardingSource, /\['I-9', 'W-4', 'DE 4', 'DE 34', 'California pamphlets', 'workers compensation', 'payroll'\]/);
  assert.equal(root.protocol, 'file:');
});


test('direct sender CLIs refuse paths that bypass the onboarding approval engine', () => {
  const commands = [
    ['run-packet.mjs', ['plan']],
    ['run-packet.mjs', ['start']],
    ['send-signing-link.mjs', ['deliver']],
    ['send-pamphlets.mjs', ['send']],
    ['send-programs.mjs', ['send']],
  ];
  for (const [script, args] of commands) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL(`../pipeline/${script}`, import.meta.url)),
      ...args,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${script} ${args.join(' ')} unexpectedly succeeded`);
    assert.match(result.stderr, /disabled|only through/, `${script}: ${result.stderr}`);
  }
});
