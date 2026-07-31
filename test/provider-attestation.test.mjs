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

test('retained v1 attestation matches its pinned immutable identity', () => {
  validateLegacyProviderAttestation(legacy);
  assert.equal(legacy.attestationSha256, LEGACY_AGGREGATE_SHA256);
  assert.equal(legacy.entries.length, 2);
  for (const entry of legacy.entries) {
    assert.equal(entry.entrySha256, LEGACY_ENTRY_SHA256[entry.slug]);
  }
});

test('current attestation validates under the current schema and differs from v1', () => {
  validateProviderAttestation(current);
  assert.equal(current.schemaVersion, 2);
  assert.notEqual(current.attestationSha256, legacy.attestationSha256);
  for (const entry of current.entries) {
    assert.notEqual(entry.entrySha256, LEGACY_ENTRY_SHA256[entry.slug]);
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
