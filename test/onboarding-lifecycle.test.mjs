import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'hamilton-onboarding-lifecycle-'));
const secretPath = join(scratch, 'docuseal.json');
writeFileSync(secretPath, JSON.stringify({
  url: 'https://docuseal.test',
  publicUrl: 'https://sign.test',
  apiKey: 'test',
  email: 'admin@example.test',
}));
process.env.DOCUSEAL_SECRET_PATH = secretPath;
process.env.HAMILTON_ONBOARDING_STATE_DIR = join(scratch, 'onboarding');
process.env.HAMILTON_PACKET_STATE_DIR = join(scratch, 'packets');

const responses = new Map();
globalThis.fetch = async (url) => {
  const id = Number(String(url).match(/submissions\/(\d+)/)?.[1]);
  const value = responses.get(id);
  if (!value) return new Response('not found', { status: 404 });
  return Response.json(value);
};

const { createRecord, approveCopy, recordGate } = await import('../pipeline/onboarding-state.mjs');
const {
  assertCopyHash,
  contractorPreSendGateBlockers,
  contractorRoleScopeRelease,
  contractorStartGate,
  hashCopyBundle,
  synchronize,
  wageNoticeBlockers,
} = await import('../pipeline/onboarding.mjs');

const intake = {
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
};

function packet(deliveredAt) {
  return {
    docs: [{ key: 'contractor-agreement', title: 'Independent Contractor Agreement' }],
    sent: [{
      key: 'contractor-agreement',
      title: 'Independent Contractor Agreement',
      submissionId: 901,
      ...(deliveredAt ? { deliveredAt } : {}),
    }],
  };
}

function submission(workerCompleted, hamiltonCompleted) {
  return {
    id: 901,
    submitters: [
      { id: 1, role: 'Worker', ...(workerCompleted ? { completed_at: workerCompleted } : {}) },
      { id: 2, role: 'Hamilton', ...(hamiltonCompleted ? { completed_at: hamiltonCompleted } : {}) },
    ],
  };
}

test('lifecycle distinguishes worker signature, countersign, copy, and filing', async () => {
  const record = createRecord('overseas_contractor', intake, {
    id: 'zz-test-lifecycle',
    now: '2026-07-29T12:00:00.000Z',
  });

  responses.set(901, submission('2026-07-29T12:01:00.000Z'));
  await synchronize(record, packet());
  assert.equal(record.phase, 'awaiting_countersignature');
  assert.equal(record.documents[0].workerSignedAt, '2026-07-29T12:01:00.000Z');
  assert.equal(record.documents[0].countersignedAt, undefined);

  responses.set(901, submission(
    '2026-07-29T12:01:00.000Z',
    '2026-07-29T12:02:00.000Z',
  ));
  await synchronize(record, packet());
  assert.equal(record.phase, 'awaiting_executed_copy_delivery');

  await synchronize(record, packet('2026-07-29T12:03:00.000Z'));
  assert.equal(record.phase, 'awaiting_filing');

  record.documents[0].filedAt = '2026-07-29T12:04:00.000Z';
  await synchronize(record, packet('2026-07-29T12:03:00.000Z'));
  assert.equal(record.phase, 'awaiting_manual_gates');
});


test('copy approval fails closed when any recipient-facing content changes', () => {
  const record = createRecord('overseas_contractor', intake, { id: 'zz-test-copy-hash' });
  const original = {
    packet: { intro: 'ZZ TEST introduction' },
    manualArtifacts: { documents: [{ caption: 'ZZ TEST role scope', sha256: 'a'.repeat(64) }] },
  };
  const approvedHash = hashCopyBundle(original);
  approveCopy(record, 'ZZ TEST exact-copy approval', approvedHash);
  assert.doesNotThrow(() => assertCopyHash(record, approvedHash));

  const copyChanged = structuredClone(original);
  copyChanged.packet.intro = 'ZZ TEST changed introduction';
  assert.throws(() => assertCopyHash(record, hashCopyBundle(copyChanged)), /no longer matches/);

  const artifactChanged = structuredClone(original);
  artifactChanged.manualArtifacts.documents[0].sha256 = 'b'.repeat(64);
  assert.throws(() => assertCopyHash(record, hashCopyBundle(artifactChanged)), /no longer matches/);
});

test('contractor agreement start validates the canonical scope before pre-send gates', () => {
  const record = createRecord('overseas_contractor', intake, { id: 'zz-test-contractor-gates' });
  assert.equal(contractorRoleScopeRelease(record).approved, false,
    'the current canonical manifest must remain fail-closed until owner-approved scope exists');
  assert.throws(() => contractorStartGate(record, { approved: true }),
    /owner-approved for release/,
    'a caller-supplied release object cannot bypass canonical scope validation');
  assert.deepEqual(contractorPreSendGateBlockers(record), [
    'role_scope_approved',
    'w8ben_instructions_delivered',
    'role_expectations_delivered',
    'payment_rail_verified',
  ]);
  for (const gate of [
    'role_scope_approved',
    'w8ben_instructions_delivered',
    'role_expectations_delivered',
    'payment_rail_verified',
  ]) {
    recordGate(record, gate, `ZZ TEST evidence ${gate}`);
  }
  assert.deepEqual(contractorPreSendGateBlockers(record), []);
  assert.throws(() => contractorStartGate(record), /owner-approved for release/);
});

test('W-2 wage notice requires both class 5552 and populated live policy fields', () => {
  const record = createRecord('w2_local', {
    name: 'ZZ TEST Roofer',
    phone: '+16509770002',
    language: 'en',
    role: 'Roofer',
    startDate: '2026-08-01',
    baseHourlyRate: 30,
    productionBonusRate: 10,
    sickLeaveMethod: 'accrual',
    payday: 'Friday',
  }, { id: 'zz-test-wage-notice-gates' });
  const wageNotice = { key: 'wage-notice' };
  assert.deepEqual(wageNoticeBlockers(record, wageNotice), [
    'wc_5552_bound',
    'wage_notice_wc_fields_verified',
  ]);
  recordGate(record, 'wc_5552_bound', 'ZZ TEST policy evidence');
  assert.deepEqual(wageNoticeBlockers(record, wageNotice), ['wage_notice_wc_fields_verified']);
  recordGate(record, 'wage_notice_wc_fields_verified', 'ZZ TEST live-template verification');
  assert.deepEqual(wageNoticeBlockers(record, wageNotice), []);
  assert.deepEqual(wageNoticeBlockers(record, { key: 'employment-agreement' }), []);
});
