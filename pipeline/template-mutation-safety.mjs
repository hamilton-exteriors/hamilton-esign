import {
  closeSync,
  fsyncSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { canonicalProviderPdfName } from './packet-topology.mjs';

export const DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES = Object.freeze({
  conditionalMutation: false,
  reason: 'DocuSeal template upload/PUT endpoints expose no ETag, version precondition, or other atomic compare-and-swap mutation',
});

export function requireProviderConditionalMutation(capabilities = DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES) {
  if (capabilities?.conditionalMutation !== true) {
    throw new Error(`unsafe in-place template migration is disabled: ${capabilities?.reason || 'provider conditional mutation is unavailable'}`);
  }
}

function own(object, key) {
  return object != null && Object.hasOwn(object, key);
}

function submissionTemplateId(submission) {
  const ids = [];
  if (own(submission, 'template_id') && submission.template_id != null) ids.push(submission.template_id);
  if (own(submission, 'template') && submission.template && own(submission.template, 'id') && submission.template.id != null) {
    ids.push(submission.template.id);
  }
  const normalized = [...new Set(ids.map(String))];
  if (normalized.length > 1) throw new Error('submission has conflicting template identifiers');
  return normalized[0] || null;
}

function requireSubmissionActivity(submission, context) {
  if (!own(submission, 'archived_at')) throw new Error(`${context} is missing archived_at; activity is unknown`);
}

function requireActiveSubmissionSnapshotProperties(submission, context) {
  if (!own(submission, 'template_fields') || !own(submission, 'template_schema')) {
    throw new Error(`${context} is missing template snapshot properties; mutation safety is unknown`);
  }
}

/**
 * Proves that every submission is either archived or belongs to another template.
 * An active submission for a target template always blocks mutation. Summaries that
 * omit activity, identity, or snapshot properties are not treated as evidence of safety.
 */
export async function assertNoBlockingSubmissions({ submissions, targetTemplateIds, readSubmission }) {
  const targets = new Set([...targetTemplateIds].map(String));
  for (const summary of submissions) {
    if (!summary || summary.id == null) throw new Error('submission inventory contains an entry with unknown identity');
    const context = `submission ${summary.id}`;
    if (!own(summary, 'archived_at')) throw new Error(`${context} is missing archived_at; activity is unknown`);
    if (summary.archived_at) continue;

    let templateId;
    try { templateId = submissionTemplateId(summary); }
    catch (error) { throw new Error(`${context} ${error.message}`); }
    if (templateId && !targets.has(templateId)) continue;
    if (typeof readSubmission !== 'function') {
      throw new Error(`${context} is not positively proven unrelated to the target template`);
    }

    const full = await readSubmission(summary.id);
    requireSubmissionActivity(full, context);
    if (full.archived_at) continue;
    requireActiveSubmissionSnapshotProperties(full, context);
    let fullTemplateId;
    try { fullTemplateId = submissionTemplateId(full); }
    catch (error) { throw new Error(`${context} ${error.message}`); }
    if (!fullTemplateId) throw new Error(`${context} is missing a template identifier; relation is unknown`);
    if (!targets.has(fullTemplateId)) continue;
    throw new Error(`${context} is active for template ${fullTemplateId}; refusing template mutation`);
  }
}

const GEOMETRY_KEYS = ['page', 'x', 'y', 'w', 'h'];
const SHA256 = /^[a-f0-9]{64}$/;
const sameGeometry = (left, right) => GEOMETRY_KEYS.every((key) => left?.[key] === right?.[key]);

function canonicalOptionalDescription(value, context) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${context} description must be a string when present`);
  return value;
}

function assertFieldPresentationReadback(actual, expected, context) {
  if (typeof expected.name !== 'string' || expected.name.length === 0) {
    throw new Error(`${context}: expected field name must be nonempty`);
  }
  if (actual.name !== expected.name) throw new Error(`${context}: provider field name changed`);

  const expectedDescription = canonicalOptionalDescription(expected.description, `${context}: expected field`);
  const actualDescription = canonicalOptionalDescription(actual.description, `${context}: provider field`);
  if (actualDescription !== expectedDescription) throw new Error(`${context}: provider field description changed`);

  if (typeof expected.required !== 'boolean') throw new Error(`${context}: expected required flag must be a boolean`);
  if (typeof actual.required !== 'boolean' || actual.required !== expected.required) {
    throw new Error(`${context}: provider field required flag changed`);
  }
}

function uniqueUuidMap(values, context) {
  const map = new Map();
  for (const value of values || []) {
    if (!value?.uuid || map.has(value.uuid)) throw new Error(`${context} UUIDs must be present and unique`);
    map.set(value.uuid, value);
  }
  return map;
}

/** Verify the provider read-back before any UUID is bound into a reflow view. */
export function verifyCreatedTemplateReadback({
  saved,
  expectedId,
  expectedName,
  expectedSchema,
  expectedDocuments,
  savedDocumentDigests,
  expectedSubmitters,
  expectedFields,
  measuredFields,
  ownerUuidByOwner,
}) {
  if (expectedId != null && String(saved?.id) !== String(expectedId)) {
    throw new Error('created template identity failed read-back verification');
  }
  if (saved?.name !== expectedName) throw new Error('created template name failed read-back verification');

  const expectedSchemaDocuments = (expectedSchema || []).map((document) => ({
    attachment_uuid: document?.attachment_uuid,
    name: document?.name,
  }));
  const savedSchemaDocuments = (saved?.schema || []).map((document) => ({
    attachment_uuid: document?.attachment_uuid,
    name: document?.name,
  }));
  const expectedAttachments = expectedSchemaDocuments.map((document) => document.attachment_uuid);
  if (!expectedAttachments.length || expectedAttachments.some((uuid) => !uuid) ||
      new Set(expectedAttachments).size !== expectedAttachments.length ||
      expectedSchemaDocuments.some((document) => !document.name)) {
    throw new Error('expected document UUID/name coverage is invalid');
  }
  if (savedSchemaDocuments.length !== expectedSchemaDocuments.length) {
    throw new Error('created template document UUID/name/order differs from the uploaded schema');
  }
  expectedSchemaDocuments.forEach((expected, index) => {
    const actual = savedSchemaDocuments[index];
    if (actual.attachment_uuid !== expected.attachment_uuid ||
      canonicalProviderPdfName(actual.name) !== canonicalProviderPdfName(expected.name)) {
      throw new Error('created template document UUID/name/order differs from the uploaded schema');
    }
  });
  if (!Array.isArray(expectedDocuments) || expectedDocuments.length !== expectedAttachments.length ||
      !Array.isArray(saved?.documents) || saved.documents.length !== expectedAttachments.length) {
    throw new Error('created template provider document coverage changed');
  }
  const digestMap = savedDocumentDigests instanceof Map
    ? savedDocumentDigests
    : new Map(Object.entries(savedDocumentDigests || {}));
  expectedDocuments.forEach((expected, index) => {
    const actual = saved.documents[index];
    if (expected.uuid !== expectedAttachments[index] || actual?.uuid !== expected.uuid ||
      canonicalProviderPdfName(actual?.filename) !== canonicalProviderPdfName(expected.filename)) {
      throw new Error(`created template provider document ${index} UUID/filename/order changed`);
    }
    if (!SHA256.test(expected.sha256 || '') || digestMap.get(expected.uuid) !== expected.sha256) {
      throw new Error(`created template provider document ${index} digest changed`);
    }
  });
  if (digestMap.size !== expectedDocuments.length) {
    throw new Error('created template provider document digest coverage changed');
  }

  const expectedRoles = uniqueUuidMap(expectedSubmitters, 'expected submitter');
  const savedRoles = uniqueUuidMap(saved?.submitters, 'saved submitter');
  if (expectedRoles.size !== savedRoles.size) throw new Error('created template submitter count changed');
  for (const [uuid, expected] of expectedRoles) {
    const actual = savedRoles.get(uuid);
    if (!actual || actual.name !== expected.name) throw new Error(`created template submitter ${uuid} changed role`);
  }

  if (expectedFields.length !== measuredFields.length) throw new Error('expected measured field mapping is not one-to-one');
  const measuredIds = new Set();
  const expectedByUuid = uniqueUuidMap(expectedFields, 'expected field');
  const savedByUuid = uniqueUuidMap(saved?.fields, 'saved field');
  if (expectedByUuid.size !== savedByUuid.size) throw new Error('created template field UUID coverage changed');

  const uuidById = {};
  for (let index = 0; index < measuredFields.length; index += 1) {
    const measured = measuredFields[index];
    const expected = expectedFields[index];
    if (!measured?.id || measuredIds.has(measured.id)) throw new Error('measured field IDs must be present and unique');
    measuredIds.add(measured.id);
    const ownerUuid = ownerUuidByOwner?.[measured.owner];
    if (!ownerUuid || !expectedRoles.has(ownerUuid)) throw new Error(`${measured.id}: measured owner has no guarded submitter role`);
    if (expected.type !== measured.type || expected.submitter_uuid !== ownerUuid || expected.areas?.length !== 1 ||
        !sameGeometry(expected.areas[0], measured) || !expectedAttachments.includes(expected.areas[0].attachment_uuid)) {
      throw new Error(`${measured.id}: local field does not match the measured type, owner, geometry, and document UUID`);
    }

    const actual = savedByUuid.get(expected.uuid);
    if (!actual) throw new Error(`${measured.id}: provider read-back omitted field UUID ${expected.uuid}`);
    assertFieldPresentationReadback(actual, expected, measured.id);
    if (actual.type !== measured.type || actual.submitter_uuid !== ownerUuid || actual.areas?.length !== 1 ||
        !sameGeometry(actual.areas[0], measured) || actual.areas[0].attachment_uuid !== expected.areas[0].attachment_uuid) {
      throw new Error(`${measured.id}: provider field type, role ownership, geometry, or document UUID differs from measured mapping`);
    }
    uuidById[measured.id] = actual.uuid;
  }
  return uuidById;
}

export async function withCreatedTemplateCleanup(work, { cleanupTemplate }) {
  const createdIds = [];
  try {
    return await work((id) => {
      if (id == null || createdIds.includes(id)) throw new Error('created template ID must be present and unique');
      createdIds.push(id);
    });
  } catch (error) {
    const cleanupErrors = [];
    for (const id of [...createdIds].reverse()) {
      try { await cleanupTemplate(id); }
      catch (cleanupError) { cleanupErrors.push(`${id}: ${cleanupError.message}`); }
    }
    if (cleanupErrors.length) {
      throw new Error(`template creation failed (${error.message}); partial cleanup failed: ${cleanupErrors.join('; ')}`);
    }
    throw new Error(`template creation failed; archived ${createdIds.length} partial template(s): ${error.message}`);
  }
}

/** Atomically creates a small exclusive marker. There is no exists-then-write race. */
export function createExclusiveFile(path, contents) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function removeExclusiveFile(path) {
  rmSync(path, { force: true });
}
