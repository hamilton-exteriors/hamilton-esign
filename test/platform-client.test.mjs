import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformOnboardingClient, platformCutoverEnabled } from '../pipeline/platform-client.mjs';
import { buildRoleReleasePayload, validateIntakeForPlatform } from '../pipeline/onboarding.mjs';

test('Platform client uses internal bearer auth and rejects private data', async () => {
  let request;
  const client = createPlatformOnboardingClient({
    env: { PLATFORM_INTERNAL_URL: 'https://platform.internal/', PLATFORM_INTERNAL_TOKEN: 'operator-token' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ onboardingId: 'ob-1', phase: 'ready_to_send' }), { status: 200 });
    },
  });
  assert.deepEqual(await client.status('ob-1'), { onboardingId: 'ob-1', phase: 'ready_to_send' });
  assert.equal(request.url, 'https://platform.internal/internal/onboarding/ob-1/status');
  assert.equal(request.options.headers.authorization, 'Bearer operator-token');

  const unsafe = createPlatformOnboardingClient({
    env: { PLATFORM_INTERNAL_URL: 'https://platform.internal', PLATFORM_INTERNAL_TOKEN: 'operator-token' },
    fetchImpl: async () => new Response(JSON.stringify({ signingLink: 'https://docuseal/s/private' }), { status: 200 }),
  });
  await assert.rejects(() => unsafe.status('ob-1'), /not permitted/);

  const unsafeError = createPlatformOnboardingClient({
    env: { PLATFORM_INTERNAL_URL: 'https://platform.internal', PLATFORM_INTERNAL_TOKEN: 'operator-token' },
    fetchImpl: async () => new Response(JSON.stringify({ error: 'provider failed at https://docuseal.example/s/private' }), { status: 409 }),
  });
  await assert.rejects(() => unsafeError.status('ob-1'), /private signing data/);
});

test('role-release publication hashes exact UTF-8 and uses the dedicated authenticated route', async () => {
  let request;
  const client = createPlatformOnboardingClient({
    env: { PLATFORM_INTERNAL_URL: 'https://platform.internal', PLATFORM_INTERNAL_TOKEN: 'operator-token' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ roleReleaseId: 'release-1', roleKey: 'estimator' }, { status: 201 });
    },
  });
  const metadata = {
    roleKey: 'estimator',
    displayName: 'Estimator',
    releaseVersion: '2.0',
    artifactReference: 'role_scope:estimator-2.0',
    approvalReference: 'approval:estimator-2.0-20260730',
    approvedByName: 'Alex Li, President',
    approvedAt: '2026-07-30T00:00:00Z',
  };
  const payload = buildRoleReleasePayload(metadata, 'Exact UTF-8 role scope é\n');
  await client.publishRoleRelease(payload);
  assert.equal(request.url, 'https://platform.internal/internal/onboarding/role-releases');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, 'Bearer operator-token');
  assert.deepEqual(JSON.parse(request.options.body), payload);
  assert.match(payload.artifactDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => buildRoleReleasePayload({ ...metadata, extra: 'forbidden' }, 'scope'), /malformed/);
});

test('Platform client binds staged plan approval and start to one immutable digest', async () => {
  const requests = [];
  const client = createPlatformOnboardingClient({
    env: { PLATFORM_INTERNAL_URL: 'https://platform.internal', PLATFORM_INTERNAL_TOKEN: 'operator-token' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ ok: true });
    },
  });
  const digest = 'a'.repeat(64);
  await client.plan('ob-1', 'training');
  await client.approveCopy('ob-1', 'plan-1', 'training', digest, 'approval:owner_review');
  await client.start('ob-1', 'plan-1', 'training', digest);
  await client.rebindRole('ob-1', 'estimator', '2.0');
  await client.resolveEffect('ob-1', `woe_${'b'.repeat(64)}`, 'succeeded', 'evidence:meta_lookup_123456', {
    kind: 'meta_message',
    providerResultReference: 'meta:wamid.123456',
  });
  await client.resolveEffect('ob-1', `woe_${'c'.repeat(64)}`, 'definite_failed', 'evidence:provider_rejection_123456');
  assert.equal(requests[0].url, 'https://platform.internal/internal/onboarding/ob-1/plan?stage=training');
  assert.deepEqual(JSON.parse(requests[1].options.body), { planId: 'plan-1', stage: 'training', copyHash: digest, approvalReference: 'approval:owner_review' });
  assert.deepEqual(JSON.parse(requests[2].options.body), { planId: 'plan-1', stage: 'training', digest });
  assert.deepEqual(JSON.parse(requests[3].options.body), { roleKey: 'estimator', releaseVersion: '2.0' });
  assert.deepEqual(JSON.parse(requests[4].options.body), {
    idempotencyKey: `woe_${'b'.repeat(64)}`,
    outcome: 'succeeded',
    evidenceReference: 'evidence:meta_lookup_123456',
    successProof: { kind: 'meta_message', providerResultReference: 'meta:wamid.123456' },
  });
  assert.deepEqual(JSON.parse(requests[5].options.body), {
    idempotencyKey: `woe_${'c'.repeat(64)}`,
    outcome: 'definite_failed',
    evidenceReference: 'evidence:provider_rejection_123456',
  });
  assert.throws(
    () => client.resolveEffect('ob-1', `woe_${'d'.repeat(64)}`, 'succeeded', 'evidence:meta_lookup_123456', null),
    /malformed/,
  );
  assert.throws(
    () => client.resolveEffect('ob-1', `woe_${'e'.repeat(64)}`, 'succeeded', 'evidence:meta_lookup_123456', { kind: 'meta_message', providerResultReference: 'https://private.example/s/token' }),
    /malformed/,
  );
});

test('cutover intake keeps local normalization but projects only strict Platform fields', () => {
  const normalized = validateIntakeForPlatform('w2_local', {
    name: '  ZZ Test Worker  ',
    phone: '+16509770001',
    role: 'Roofer',
    startDate: '2026-08-01',
    language: '',
    hourlyGuaranteeRate: '16.9',
    pieceRatePerSquare: '37.5',
    comparisonMethod: 'greater_of',
    workweek: 'sunday_saturday',
    sickLeaveMethod: 'accrual',
    payday: 'Friday',
    localOnlyNote: 'must not cross the API boundary',
  });
  assert.deepEqual(normalized, {
    name: 'ZZ Test Worker',
    phone: '+16509770001',
    role: 'Roofer',
    startDate: '2026-08-01',
    language: 'en',
    hourlyGuaranteeRate: 16.9,
    pieceRatePerSquare: 37.5,
    comparisonMethod: 'greater_of',
    workweek: 'sunday_saturday',
    sickLeaveMethod: 'accrual',
    payday: 'Friday',
  });
});

test('cutover is opt-in only', () => {
  assert.equal(platformCutoverEnabled({}), false);
  assert.equal(platformCutoverEnabled({ HAMILTON_PLATFORM_ONBOARDING_CUTOVER: 'true' }), true);
});

test('Platform client exposes reconcile but not manual filing after cutover', () => {
  const client = createPlatformOnboardingClient({
    env: { PLATFORM_INTERNAL_URL: 'https://platform.internal', PLATFORM_INTERNAL_TOKEN: 'operator-token' },
    fetchImpl: async () => Response.json({ ok: true }),
  });
  assert.equal(typeof client.reconcile, 'function');
  assert.equal(client.file, undefined);
});
