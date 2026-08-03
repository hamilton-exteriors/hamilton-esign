import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  requireLegacyProviderAttestationEntry,
  validateLegacyProviderAttestation,
  validateProviderAttestation,
} from '../pipeline/provider-attestation.mjs';

const legacy = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations-v1.json', import.meta.url),
  'utf8',
));
const retainedV2 = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations-v2.json', import.meta.url),
  'utf8',
));
const retainedV3 = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations-v3.json', import.meta.url),
  'utf8',
));
const current = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations.json', import.meta.url),
  'utf8',
));

// The v1 file is the immutable attestation that retained schema-v3 plans bind.
// Its identity is pinned by value: a regenerated or swapped file that still
// self-validates must fail here, because real production plans reference these
// exact digests and would be stranded by any replacement.
const LEGACY_AGGREGATE_SHA256 = 'e9039d51d8cb462f3cc05306dc62e905de8af06ac1cd21f535cd8324021688e8';
const LEGACY_ENTRY_SHA256 = {
  'w2-initial-packet-v3': '300d3a94c4829f99561411ca364fc5762d02a13e572d34851ffc032417a291db',
  'w2-initial-packet-es-v3': '9e60f1e247f12fd2c2d6ffbf23355cc086623a4be37f805b457d547ce3df9ef3',
};

// The v2 file is the immutable gen-C attestation for retained templates 380/381.
// Retained schema-v4 plans and retained v3 live verification bind these exact
// digests after the v4 capture replaced provider-attestations.json.
const RETAINED_V2_AGGREGATE_SHA256 = 'd43df547a3d815e54678bb72fcef65f39b3271cfa97f65afcb9d3504596dd8d7';
const RETAINED_V2_ENTRY_SHA256 = {
  'w2-initial-packet-v3': '54bf6eabc157ea7e2c948a2d2e00588df70329cb12b6405d9ca4a0265fb1f208',
  'w2-initial-packet-es-v3': 'c3ba4158c721607f4f98170901505bfff75cbb3d3112f8cf571d136f649819b8',
};

// The v3 file is the immutable gen-D attestation for retained templates 382/383.
// Retained schema-v5 plans and retained v4 live verification bind these exact
// digests after the v5 capture replaced provider-attestations.json.
const RETAINED_V3_AGGREGATE_SHA256 = '03676a00d46e2dd70d392679b6c87b984bc27c6af0f4ab3cfbf0fcabd94d9279';
const RETAINED_V3_ENTRY_SHA256 = {
  'w2-initial-packet-v4': '5db7760ab75e4a5f7700a83a1619d16f781e1049a4151ff765cd7e7c8d9f5f60',
  'w2-initial-packet-es-v4': '33125cab6e2d70b7c3a981d4ade56021140d197a1b3d64c62cb0a7533d1e45cf',
};

test('retained v1 attestation matches its pinned immutable identity', () => {
  validateLegacyProviderAttestation(legacy);
  assert.equal(legacy.attestationSha256, LEGACY_AGGREGATE_SHA256);
  assert.equal(legacy.entries.length, 2);
  for (const entry of legacy.entries) {
    assert.equal(entry.entrySha256, LEGACY_ENTRY_SHA256[entry.slug]);
  }
});

test('retained v2 attestation matches its pinned immutable gen-C identity', () => {
  validateProviderAttestation(retainedV2);
  assert.equal(retainedV2.schemaVersion, 2);
  assert.equal(retainedV2.attestationSha256, RETAINED_V2_AGGREGATE_SHA256);
  assert.deepEqual(
    retainedV2.entries.map((entry) => [entry.slug, entry.entrySha256, entry.templateId, entry.registryVersion]),
    [
      ['w2-initial-packet-v3', RETAINED_V2_ENTRY_SHA256['w2-initial-packet-v3'], '380', 3],
      ['w2-initial-packet-es-v3', RETAINED_V2_ENTRY_SHA256['w2-initial-packet-es-v3'], '381', 3],
    ],
  );
  assert.throws(() => validateLegacyProviderAttestation(retainedV2), /legacy provider attestation/);
  for (const entry of retainedV2.entries) {
    assert.notEqual(entry.entrySha256, LEGACY_ENTRY_SHA256[entry.slug]);
  }
});

test('retained v3 attestation matches its pinned immutable gen-D identity', () => {
  validateProviderAttestation(retainedV3);
  assert.equal(retainedV3.schemaVersion, 2);
  assert.equal(retainedV3.attestationSha256, RETAINED_V3_AGGREGATE_SHA256);
  assert.deepEqual(
    retainedV3.entries.map((entry) => [entry.slug, entry.entrySha256, entry.templateId, entry.registryVersion]),
    [
      ['w2-initial-packet-v4', RETAINED_V3_ENTRY_SHA256['w2-initial-packet-v4'], '382', 4],
      ['w2-initial-packet-es-v4', RETAINED_V3_ENTRY_SHA256['w2-initial-packet-es-v4'], '383', 4],
    ],
  );
  assert.throws(() => validateLegacyProviderAttestation(retainedV3), /legacy provider attestation/);
  for (const entry of retainedV3.entries) {
    assert.ok(!Object.values(RETAINED_V2_ENTRY_SHA256).includes(entry.entrySha256));
    assert.ok(!Object.values(LEGACY_ENTRY_SHA256).includes(entry.entrySha256));
  }
});

test('current attestation validates under the current schema and binds one exact generation', () => {
  validateProviderAttestation(current);
  assert.equal(current.schemaVersion, 2);
  assert.notEqual(current.attestationSha256, legacy.attestationSha256);
  // Released v5 state: the live file holds the gen-E (v5, templates 384/385)
  // generation and must not reuse any retained generation's digest.
  const slugs = current.entries.map((entry) => entry.slug).sort();
  assert.deepEqual(slugs, ['w2-initial-packet-es-v5', 'w2-initial-packet-v5']);
  assert.notEqual(current.attestationSha256, RETAINED_V2_AGGREGATE_SHA256);
  assert.notEqual(current.attestationSha256, RETAINED_V3_AGGREGATE_SHA256);
  for (const entry of current.entries) {
    assert.equal(entry.registryVersion, 5);
    assert.ok(!Object.values(RETAINED_V3_ENTRY_SHA256).includes(entry.entrySha256));
    assert.ok(!Object.values(RETAINED_V2_ENTRY_SHA256).includes(entry.entrySha256));
    assert.ok(!Object.values(LEGACY_ENTRY_SHA256).includes(entry.entrySha256));
  }
});

test('legacy validator rejects the current schema-v2 attestation', () => {
  assert.throws(() => validateLegacyProviderAttestation(current), /legacy provider attestation/);
});

test('current validator rejects the legacy schema-v1 attestation', () => {
  assert.throws(() => validateProviderAttestation(legacy), /provider attestation/);
});

test('legacy validator fails closed on tampering and shape drift', () => {
  const tamperEntryDigest = structuredClone(legacy);
  tamperEntryDigest.entries[0].entrySha256 = 'f'.repeat(64);
  assert.throws(() => validateLegacyProviderAttestation(tamperEntryDigest), /digest is invalid/);

  const tamperAggregate = structuredClone(legacy);
  tamperAggregate.attestationSha256 = 'f'.repeat(64);
  assert.throws(() => validateLegacyProviderAttestation(tamperAggregate), /aggregate digest is invalid/);

  const rawByteDrift = structuredClone(legacy);
  rawByteDrift.entries[0].documents[0].providerRawSha256 = 'f'.repeat(64);
  assert.throws(() => validateLegacyProviderAttestation(rawByteDrift), /is invalid/);

  const smuggledFieldRegions = structuredClone(legacy);
  smuggledFieldRegions.entries[0].documents[0].fieldRegions = [];
  assert.throws(() => validateLegacyProviderAttestation(smuggledFieldRegions), /is invalid/);

  const smuggledByteLength = structuredClone(legacy);
  smuggledByteLength.entries[0].documents[0].sourceByteLength = 1;
  assert.throws(() => validateLegacyProviderAttestation(smuggledByteLength), /is invalid/);

  const missingFingerprint = structuredClone(legacy);
  delete missingFingerprint.entries[0].documents[0].fingerprint;
  assert.throws(() => validateLegacyProviderAttestation(missingFingerprint));

  const duplicateSlug = structuredClone(legacy);
  duplicateSlug.entries[1].slug = duplicateSlug.entries[0].slug;
  assert.throws(() => validateLegacyProviderAttestation(duplicateSlug), /structure is invalid/);
});

test('requireLegacyProviderAttestationEntry resolves known slugs and rejects unknown ones', () => {
  const entry = requireLegacyProviderAttestationEntry(legacy, 'w2-initial-packet-v3');
  assert.equal(entry.entrySha256, LEGACY_ENTRY_SHA256['w2-initial-packet-v3']);
  assert.throws(() => requireLegacyProviderAttestationEntry(legacy, 'w2-initial-packet-v9'), /no unique entry/);
});
