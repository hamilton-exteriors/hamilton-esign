import { createHash } from 'node:crypto';
import { PDF_FINGERPRINT_ALGORITHM, PDF_FINGERPRINT_SCALE, validatePdfFingerprint } from './pdf-fingerprint.mjs';

export const PROVIDER_ATTESTATION_SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
    const normalized = {
      slug: entry.slug,
      registryVersion: entry.registryVersion,
      templateId: String(entry.templateId),
      templateName: entry.templateName,
      layoutSha256: entry.layoutSha256,
      reflowSha256: entry.reflowSha256,
      documents: entry.documents.map((document, order) => {
        if (!SHA256.test(document.localRawSha256 || '') ||
          document.providerRawSha256 !== document.localRawSha256) {
          throw new Error(`${entry.slug}: provider document ${order} must be byte-identical to the approved local source`);
        }
        return {
          order,
          uuid: document.uuid,
          filename: document.filename,
          localRawSha256: document.localRawSha256,
          providerRawSha256: document.providerRawSha256,
          fingerprint: compactPdfFingerprint(document.fingerprint),
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
        !SHA256.test(document.localRawSha256 || '') ||
        document.providerRawSha256 !== document.localRawSha256)) {
      throw new Error(`provider attestation entry ${entry.slug || 'unknown'} is invalid`);
    }
    entry.documents.forEach((document) => validatePdfFingerprint({
      ...document.fingerprint,
      pages: Array.from({ length: document.fingerprint?.pageCount || 0 }, () => ({})),
    }, `${entry.slug} provider fingerprint`));
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
