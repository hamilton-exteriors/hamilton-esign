import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SENSITIVE_KEY_PATTERN = /^(?:.*_)?(?:url|uri|slug|author|authors|credential|credentials|password|secret|token|api_key|private_key)(?:_.*)?$/i;
const SENSITIVE_STRING_PATTERNS = [
  /(?:https?|ftp):\/\//i,
  /\bwww\./i,
  /\b(?:bearer|basic)\s+[a-z0-9+/=_-]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/,
];

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function requirePlainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, 'must be a plain object');
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  rejectSensitiveString(value, path);
  return value;
}

function requireId(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(path, 'must be a positive safe integer');
  return value;
}

function rejectSensitiveString(value, path) {
  if (SENSITIVE_STRING_PATTERNS.some((pattern) => pattern.test(value))) {
    fail(path, 'must not contain a URL or credential');
  }
}

function stableIdentity(value) {
  if (typeof value.uuid === 'string') return `0:${value.uuid}`;
  if (Number.isSafeInteger(value.id)) return `1:${String(value.id).padStart(20, '0')}`;
  if (typeof value.id === 'string') return `1:${value.id}`;
  if (typeof value.attachment_uuid === 'string') return `2:${value.attachment_uuid}`;
  if (typeof value.name === 'string') return `3:${value.name}`;
  return null;
}

function isSensitiveKey(key) {
  const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(key) || [
    'url', 'uri', 'slug', 'author', 'authors', 'credential', 'credentials', 'password',
    'secret', 'token', 'apikey', 'privatekey', 'previewurl',
  ].some((term) => compact === term || compact.endsWith(term));
}

function normalizeIncludedValue(value, path, { preserveArrayOrder = false } = {}) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    rejectSensitiveString(value, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must contain only finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    const keepOrder = preserveArrayOrder || path.endsWith('.areas');
    const normalized = value.map((item, index) => normalizeIncludedValue(item, `${path}[${index}]`));
    if (!keepOrder && normalized.length > 1 && normalized.every((item) => {
      return item !== null && typeof item === 'object' && !Array.isArray(item) && stableIdentity(item) !== null;
    })) {
      normalized.sort((left, right) => {
        const identityOrder = stableIdentity(left).localeCompare(stableIdentity(right));
        return identityOrder || JSON.stringify(left).localeCompare(JSON.stringify(right));
      });
    }
    return normalized;
  }
  requirePlainObject(value, path);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (isSensitiveKey(key)) fail(`${path}.${key}`, 'is a private or credential-bearing key');
    normalized[key] = normalizeIncludedValue(value[key], `${path}.${key}`);
  }
  return normalized;
}

function normalizeArea(area, path) {
  requirePlainObject(area, path);
  const normalized = {
    h: requireFiniteNumber(area.h, `${path}.h`),
    page: requireNonNegativeInteger(area.page, `${path}.page`),
    w: requireFiniteNumber(area.w, `${path}.w`),
    x: requireFiniteNumber(area.x, `${path}.x`),
    y: requireFiniteNumber(area.y, `${path}.y`),
  };
  if (area.attachment_uuid !== undefined) {
    normalized.attachment_uuid = requireString(area.attachment_uuid, `${path}.attachment_uuid`);
  }
  return normalizeIncludedValue(normalized, path);
}

function requireFiniteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  return value;
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer');
  return value;
}

function digestEntries(sourceDocumentDigests) {
  if (sourceDocumentDigests instanceof Map) return [...sourceDocumentDigests.entries()];
  requirePlainObject(sourceDocumentDigests, 'sourceDocumentDigests');
  return Object.entries(sourceDocumentDigests);
}

function normalizeSourceDigests(sourceDocumentDigests, documents) {
  const entries = digestEntries(sourceDocumentDigests);
  const expected = new Set(documents.map((document) => document.uuid));
  const supplied = new Map();
  for (const [uuid, digest] of entries) {
    if (typeof uuid !== 'string' || uuid.length === 0) fail('sourceDocumentDigests', 'keys must be document UUIDs');
    if (supplied.has(uuid)) fail(`sourceDocumentDigests.${uuid}`, 'is duplicated');
    if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
      fail(`sourceDocumentDigests.${uuid}`, 'must be a 64-character SHA-256 hex digest');
    }
    supplied.set(uuid, digest.toLowerCase());
  }
  const missing = [...expected].filter((uuid) => !supplied.has(uuid)).sort();
  const extra = [...supplied.keys()].filter((uuid) => !expected.has(uuid)).sort();
  if (missing.length || extra.length) {
    throw new TypeError(`sourceDocumentDigests must exactly cover template documents (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
  return supplied;
}

/**
 * Builds the privacy-safe, deterministic subset of a DocuSeal template API object.
 * Source digests are an object or Map keyed exactly by document UUID.
 */
export function normalizeTemplateSnapshot(template, sourceDocumentDigests) {
  requirePlainObject(template, 'template');
  requireId(template.id, 'template.id');
  requireString(template.name, 'template.name');
  requireString(template.updated_at, 'template.updated_at');
  if (!ISO_TIMESTAMP_PATTERN.test(template.updated_at) || !Number.isFinite(Date.parse(template.updated_at))) {
    fail('template.updated_at', 'must be an ISO 8601 timestamp with a timezone');
  }
  requirePlainObject(template.preferences, 'template.preferences');
  if (!Array.isArray(template.schema)) fail('template.schema', 'must be an array');
  requirePlainObject(template.variables_schema, 'template.variables_schema');
  if (!Array.isArray(template.submitters)) fail('template.submitters', 'must be an array');
  if (!Array.isArray(template.fields)) fail('template.fields', 'must be an array');
  if (!Array.isArray(template.documents)) fail('template.documents', 'must be an array');

  const submitterUuids = new Set();
  const submitters = template.submitters.map((submitter, index) => {
    const path = `template.submitters[${index}]`;
    requirePlainObject(submitter, path);
    const uuid = requireString(submitter.uuid, `${path}.uuid`);
    if (submitterUuids.has(uuid)) fail(`${path}.uuid`, 'must be unique');
    submitterUuids.add(uuid);
    return { name: requireString(submitter.name, `${path}.name`), uuid };
  }).sort((left, right) => left.uuid.localeCompare(right.uuid));

  const fieldUuids = new Set();
  const fields = template.fields.map((field, index) => {
    const path = `template.fields[${index}]`;
    requirePlainObject(field, path);
    const uuid = requireString(field.uuid, `${path}.uuid`);
    if (fieldUuids.has(uuid)) fail(`${path}.uuid`, 'must be unique');
    fieldUuids.add(uuid);
    const submitterUuid = requireString(field.submitter_uuid, `${path}.submitter_uuid`);
    if (!submitterUuids.has(submitterUuid)) fail(`${path}.submitter_uuid`, 'must reference a template submitter');
    if (typeof field.required !== 'boolean') fail(`${path}.required`, 'must be a boolean');
    if (!Array.isArray(field.areas) || field.areas.length === 0) fail(`${path}.areas`, 'must be a non-empty array');
    return normalizeIncludedValue({
      areas: field.areas.map((area, areaIndex) => normalizeArea(area, `${path}.areas[${areaIndex}]`)),
      name: requireString(field.name, `${path}.name`),
      required: field.required,
      submitter_uuid: submitterUuid,
      type: requireString(field.type, `${path}.type`),
      uuid,
    }, path);
  }).sort((left, right) => left.uuid.localeCompare(right.uuid));

  const documentUuids = new Set();
  const documents = template.documents.map((document, index) => {
    const path = `template.documents[${index}]`;
    requirePlainObject(document, path);
    const uuid = requireString(document.uuid, `${path}.uuid`);
    if (documentUuids.has(uuid)) fail(`${path}.uuid`, 'must be unique');
    documentUuids.add(uuid);
    return {
      filename: requireString(document.filename, `${path}.filename`),
      id: requireId(document.id, `${path}.id`),
      uuid,
    };
  });
  const sourceDigests = normalizeSourceDigests(sourceDocumentDigests, documents);
  const normalizedDocuments = documents.map((document) => normalizeIncludedValue({
    ...document,
    source_sha256: sourceDigests.get(document.uuid),
  }, 'template.documents')).sort((left, right) => left.uuid.localeCompare(right.uuid) || left.id - right.id);

  return normalizeIncludedValue({
    documents: normalizedDocuments,
    fields,
    id: template.id,
    name: template.name,
    preferences: normalizeIncludedValue(template.preferences, 'template.preferences'),
    schema: normalizeIncludedValue(template.schema, 'template.schema'),
    submitters,
    updated_at: template.updated_at,
    variables_schema: normalizeIncludedValue(template.variables_schema, 'template.variables_schema'),
  }, 'snapshot');
}

export function canonicalTemplateJson(template, sourceDocumentDigests) {
  return JSON.stringify(normalizeTemplateSnapshot(template, sourceDocumentDigests));
}

export function digestTemplateSnapshot(template, sourceDocumentDigests) {
  return createHash('sha256').update(canonicalTemplateJson(template, sourceDocumentDigests), 'utf8').digest('hex');
}

export function buildTemplateSnapshot(template, sourceDocumentDigests) {
  const snapshot = normalizeTemplateSnapshot(template, sourceDocumentDigests);
  const canonicalJson = JSON.stringify(snapshot);
  const digest = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return { snapshot, canonicalJson, digest };
}
