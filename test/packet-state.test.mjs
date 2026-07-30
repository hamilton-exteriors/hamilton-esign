import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'hamilton-packet-test-'));
const secretPath = join(scratch, 'docuseal.json');
writeFileSync(secretPath, JSON.stringify({
  url: 'https://docuseal.test',
  publicUrl: 'https://sign.test',
  apiKey: 'test',
  email: 'admin@example.test',
}));
process.env.DOCUSEAL_SECRET_PATH = secretPath;
process.env.HAMILTON_PACKET_STATE_DIR = join(scratch, 'state');

const { advance, packetCopyPreview, saveState, sendTrainingRoster } = await import('../pipeline/run-packet.mjs');

function initialState() {
  return {
    packetId: 'packet-test',
    worker: { name: 'ZZ TEST', phone: '+16509773241', language: 'en' },
    lang: 'en',
    total: 1,
    docs: [{ key: 'employment', title: 'Employment Agreement' }],
    sent: [],
    deliveries: { intro: { status: 200 } },
  };
}

test('an interrupted start remains resumable without creating work in preview', async () => {
  const state = initialState();
  const result = await advance(state, undefined, { dryRun: true });
  assert.equal(result.action, 'would-send-first');
  assert.match(result.message, /Employment Agreement/);
  assert.equal(state.sent.length, 0);
});

test('an attempted WhatsApp delivery requires an explicit ambiguous retry', async () => {
  const state = initialState();
  state.pendingDelivery = {
    kind: 'document',
    index: 0,
    key: 'employment',
    title: 'Employment Agreement',
    attemptedAt: new Date().toISOString(),
  };
  const result = await advance(state, undefined, { dryRun: true });
  assert.equal(result.action, 'delivery-ambiguous');
  assert.match(result.reason, /inspect the conversation/);
});

test('contractor copy never describes the signer as a new hire', () => {
  const preview = packetCopyPreview('overseas_contractor', 'en', [
    { title: 'Independent Contractor Agreement' },
  ], null);
  assert.match(preview.intro, /contractor onboarding packet/i);
  assert.doesNotMatch(JSON.stringify(preview), /you.re hired|new-hire/i);
  assert.match(preview.completion, /countersign/i);
  assert.doesNotMatch(JSON.stringify(preview), /https?:\/\//i);
});

test('packet state persistence removes private signing routes', () => {
  const state = initialState();
  state.pendingDelivery = {
    kind: 'document',
    index: 0,
    key: 'employment',
    title: 'Employment Agreement',
    submissionId: 123,
    link: 'https://sign.test/s/ZZ-PRIVATE',
    message: 'Sign here: https://sign.test/s/ZZ-PRIVATE',
  };
  const path = saveState(state);
  const saved = readFileSync(path, 'utf8');
  assert.doesNotMatch(saved, /ZZ-PRIVATE/);
  assert.doesNotMatch(saved, /"link"/);
  assert.match(saved, /<private signing link>/);
});

test('training roster refuses a trainer name without complete evidence', async () => {
  const state = initialState();
  await assert.rejects(
    sendTrainingRoster(state, 'ZZ TEST Trainer', 'rw.json'),
    /training evidence JSON is required/,
  );
});
