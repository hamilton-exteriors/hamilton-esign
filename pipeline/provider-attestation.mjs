import { createHash } from 'node:crypto';
import { PDF_FINGERPRINT_ALGORITHM, PDF_FINGERPRINT_SCALE, validatePdfFingerprint } from './pdf-fingerprint.mjs';

export const PROVIDER_ATTESTATION_SCHEMA_VERSION = 2;
const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FIELD_TYPES = new Set(['text', 'date', 'checkbox', 'signature', 'initials', 'number', 'image', 'phone']);
const FIELD_OWNERS = new Set(['worker', 'employer']);

function normalizedFieldRegions(regions, pageCount, slug, documentOrder, entryIds = new Set(), entryUuids = new Set()) {
  if (!Array.isArray(regions)) throw new Error(`${slug}: provider document ${documentOrder} field regions are required`);
  const ids = new Set();
  const uuids = new Set();
  return regions.map((region, order) => {
    if (region.order !== undefined && region.order !== order) throw new Error(`${slug}: provider field region order is invalid`);
    if (typeof region.id !== 'string' || !region.id || typeof region.uuid !== 'string' || !region.uuid ||
      ids.has(region.id) || uuids.has(region.uuid) || entryIds.has(region.id) || entryUuids.has(region.uuid) || !FIELD_TYPES.has(region.type) || !FIELD_OWNERS.has(region.owner) ||
      !Number.isInteger(region.page) || region.page < 0 || region.page >= pageCount ||
      ![region.x, region.y, region.w, region.h].every(Number.isFinite) || region.x < 0 || region.y < 0 ||
      region.w <= 0 || region.h <= 0 || region.x + region.w > 1 || region.y + region.h > 1) {
      throw new Error(`${slug}: provider document ${documentOrder} field region ${order} is invalid`);
    }
    ids.add(region.id); uuids.add(region.uuid); entryIds.add(region.id); entryUuids.add(region.uuid);
    return { order, id: region.id, uuid: region.uuid, type: region.type, owner: region.owner, page: region.page, x: region.x, y: region.y, w: region.w, h: region.h };
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function providerAttestationEntryDigest(entry) {
  const { entrySha256, ...body } = entry;
  return sha256(Buffer.from(JSON.stringify(canonical(body)), 'utf8'));
}

export function providerAttestationDigest(attestation) {
  const { attestationSha256, ...body } = attestation;
  return sha256(Buffer.from(JSON.stringify(canonical(body)), 'utf8'));
}

export function compactPdfFingerprint(fingerprint) {
  validatePdfFingerprint(fingerprint);
  return {
    algorithm: PDF_FINGERPRINT_ALGORITHM,
    scale: PDF_FINGERPRINT_SCALE,
    pageCount: fingerprint.pageCount,
    semanticSha256: fingerprint.semanticSha256,
    visualSha256: fingerprint.visualSha256,
    operatorSha256: fingerprint.operatorSha256,
  };
}

export function buildProviderAttestation(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('provider attestation entries are required');
  const normalizedEntries = entries.map((entry) => {
    const fieldIds = new Set();
    const fieldUuids = new Set();
    const normalized = {
      slug: entry.slug,
      registryVersion: entry.registryVersion,
      templateId: String(entry.templateId),
      templateName: entry.templateName,
      layoutSha256: entry.layoutSha256,
      reflowSha256: entry.reflowSha256,
      documents: entry.documents.map((document, order) => {
        if (!SHA256.test(document.localRawSha256 || '') ||
          document.providerRawSha256 !== document.localRawSha256 ||
          !Number.isSafeInteger(document.sourceByteLength) || document.sourceByteLength <= 0) {
          throw new Error(`${entry.slug}: provider document ${order} must have positive source length and be byte-identical to the approved local source`);
        }
        const fingerprint = compactPdfFingerprint(document.fingerprint);
        return {
          order,
          uuid: document.uuid,
          filename: document.filename,
          sourceByteLength: document.sourceByteLength,
          localRawSha256: document.localRawSha256,
          providerRawSha256: document.providerRawSha256,
          fingerprint,
          fieldRegions: normalizedFieldRegions(document.fieldRegions, fingerprint.pageCount, entry.slug, order, fieldIds, fieldUuids),
        };
      }),
    };
    return { ...normalized, entrySha256: providerAttestationEntryDigest(normalized) };
  });
  const body = { schemaVersion: PROVIDER_ATTESTATION_SCHEMA_VERSION, entries: normalizedEntries };
  return { ...body, attestationSha256: providerAttestationDigest(body) };
}

export function validateProviderAttestation(attestation, expectedEntries = 2) {
  if (!attestation || attestation.schemaVersion !== PROVIDER_ATTESTATION_SCHEMA_VERSION ||
    !Array.isArray(attestation.entries) || attestation.entries.length !== expectedEntries ||
    new Set(attestation.entries.map((entry) => entry.slug)).size !== attestation.entries.length) {
    throw new Error('provider attestation structure is invalid');
  }
  for (const entry of attestation.entries) {
    if (typeof entry.slug !== 'string' || !entry.slug || !Number.isInteger(entry.registryVersion) || entry.registryVersion < 1 ||
      !/^\d+$/.test(entry.templateId || '') || typeof entry.templateName !== 'string' || !entry.templateName ||
      !SHA256.test(entry.layoutSha256 || '') || !SHA256.test(entry.reflowSha256 || '') ||
      !Array.isArray(entry.documents) || entry.documents.length !== 15 ||
      entry.documents.some((document, order) => document.order !== order || !document.uuid || !document.filename ||
        !Number.isSafeInteger(document.sourceByteLength) || document.sourceByteLength <= 0 ||
        !SHA256.test(document.localRawSha256 || '') ||
        document.providerRawSha256 !== document.localRawSha256)) {
      throw new Error(`provider attestation entry ${entry.slug || 'unknown'} is invalid`);
    }
    const fieldIds = new Set();
    const fieldUuids = new Set();
    entry.documents.forEach((document) => {
      validatePdfFingerprint({
        ...document.fingerprint,
        pages: Array.from({ length: document.fingerprint?.pageCount || 0 }, () => ({})),
      }, `${entry.slug} provider fingerprint`);
      const regions = normalizedFieldRegions(document.fieldRegions, document.fingerprint.pageCount, entry.slug, document.order, fieldIds, fieldUuids);
      if (JSON.stringify(regions) !== JSON.stringify(document.fieldRegions)) throw new Error(`${entry.slug}: provider field regions are not canonical`);
    });
    if (entry.entrySha256 !== providerAttestationEntryDigest(entry)) {
      throw new Error(`provider attestation entry ${entry.slug} digest is invalid`);
    }
  }
  if (attestation.attestationSha256 !== providerAttestationDigest(attestation)) {
    throw new Error('provider attestation aggregate digest is invalid');
  }
  return attestation;
}

export function requireProviderAttestationEntry(attestation, slug) {
  validateProviderAttestation(attestation);
  const matches = attestation.entries.filter((entry) => entry.slug === slug);
  if (matches.length !== 1) throw new Error(`provider attestation has no unique entry for ${slug}`);
  return matches[0];
}
