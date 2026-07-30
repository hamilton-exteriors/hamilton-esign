import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  buildTemplateSnapshot,
  canonicalTemplateJson,
  digestTemplateSnapshot,
  normalizeTemplateSnapshot,
} from '../pipeline/template-snapshot.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  return {
    id: 42,
    name: 'Worker Packet',
    updated_at: '2026-07-30T12:34:56.000Z',
    preferences: { send_email: false, locale: 'en', audit: { enabled: true, modes: ['sign', 'view'] } },
    schema: [
      { attachment_uuid: 'attachment-b', name: 'policy.pdf' },
      { attachment_uuid: 'attachment-a', name: 'agreement.pdf' },
    ],
    variables_schema: {
      start_date: { uuid: 'variable-b', name: 'start_date', type: 'date' },
      legal_name: { uuid: 'variable-a', name: 'legal_name', type: 'string' },
    },
    submitters: [
      { uuid: 'submitter-worker', name: 'Worker', email: 'ignored@example.com' },
      { uuid: 'submitter-company', name: 'Hamilton', unknown: 'ignored' },
    ],
    fields: [
      {
        uuid: 'field-signature',
        name: 'Signature',
        type: 'signature',
        required: true,
        submitter_uuid: 'submitter-worker',
        areas: [{ page: 1, x: 0.2, y: 0.7, w: 0.3, h: 0.05, attachment_uuid: 'attachment-b' }],
        validation: { ignored: true },
      },
      {
        uuid: 'field-name',
        name: 'Legal name',
        type: 'text',
        required: false,
        submitter_uuid: 'submitter-company',
        areas: [
          { page: 0, x: 0.1, y: 0.2, w: 0.4, h: 0.03, attachment_uuid: 'attachment-a' },
          { page: 2, x: 0.1, y: 0.4, w: 0.4, h: 0.03, attachment_uuid: 'attachment-a' },
        ],
      },
    ],
    documents: [
      { id: 12, uuid: 'document-b', filename: 'policy.pdf', preview_url: 'https://private.invalid/ignored' },
      { id: 11, uuid: 'document-a', filename: 'agreement.pdf', slug: 'ignored-private-slug' },
    ],
    slug: 'worker-packet-private',
    author: { email: 'private@example.com' },
    preview_url: 'https://private.invalid/template',
    credentials: { token: 'private' },
    arbitrary_response_field: 'ignored',
  };
}

function digests() {
  return {
    'document-a': sha256(Buffer.from('agreement source bytes')),
    'document-b': sha256(Buffer.from('policy source bytes')),
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
}

function changedDigest(mutator) {
  const template = fixture();
  const sources = digests();
  const before = digestTemplateSnapshot(template, sources);
  mutator(template, sources);
  return [before, digestTemplateSnapshot(template, sources)];
}

function assertHashChanges(label, mutator) {
  test(`digest changes when ${label} changes`, () => {
    const [before, after] = changedDigest(mutator);
    assert.notEqual(after, before);
  });
}

test('builds only the normalized privacy-safe snapshot and consistent exports', () => {
  const template = fixture();
  const sources = digests();
  const built = buildTemplateSnapshot(template, sources);

  assert.deepEqual(built.snapshot, normalizeTemplateSnapshot(template, sources));
  assert.equal(built.canonicalJson, canonicalTemplateJson(template, sources));
  assert.equal(built.digest, digestTemplateSnapshot(template, sources));
  assert.match(built.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(built.snapshot), [
    'documents', 'fields', 'id', 'name', 'preferences', 'schema', 'submitters', 'updated_at', 'variables_schema',
  ]);
  assert.equal(built.snapshot.slug, undefined);
  assert.equal(built.snapshot.author, undefined);
  assert.equal(built.snapshot.preview_url, undefined);
  assert.equal(built.snapshot.credentials, undefined);
  assert.equal(built.snapshot.arbitrary_response_field, undefined);
  assert.deepEqual(built.snapshot.documents.map((document) => document.uuid), ['document-a', 'document-b']);
  assert.deepEqual(built.snapshot.fields.map((field) => field.uuid), ['field-name', 'field-signature']);
  assert.deepEqual(built.snapshot.submitters.map((submitter) => submitter.uuid), ['submitter-company', 'submitter-worker']);
  assert.equal(built.snapshot.documents[0].source_sha256, sources['document-a']);
});

test('canonical JSON and digest ignore object-key and non-semantic API-array order', () => {
  const original = fixture();
  const reordered = reverseObjectKeys(original);
  reordered.submitters.reverse();
  reordered.fields.reverse();
  reordered.documents.reverse();
  reordered.schema.reverse();

  assert.equal(canonicalTemplateJson(reordered, reverseObjectKeys(digests())), canonicalTemplateJson(original, digests()));
  assert.equal(digestTemplateSnapshot(reordered, reverseObjectKeys(digests())), digestTemplateSnapshot(original, digests()));
});

assertHashChanges('field name', (template) => { template.fields[0].name = 'Employee signature'; });
assertHashChanges('field type', (template) => { template.fields[0].type = 'initials'; });
assertHashChanges('field required flag', (template) => { template.fields[0].required = false; });
assertHashChanges('field geometry area', (template) => { template.fields[0].areas[0].x += 0.01; });
assertHashChanges('field area order', (template) => { template.fields[1].areas.reverse(); });
assertHashChanges('submitter identity', (template) => {
  template.submitters[0].name = 'Employee';
});
assertHashChanges('field submitter assignment', (template) => {
  template.fields[0].submitter_uuid = 'submitter-company';
});
assertHashChanges('preferences', (template) => { template.preferences.send_email = true; });
assertHashChanges('schema', (template) => { template.schema[0].name = 'safety-policy.pdf'; });
assertHashChanges('variables schema', (template) => { template.variables_schema.start_date.type = 'string'; });
assertHashChanges('updated timestamp', (template) => { template.updated_at = '2026-07-30T12:35:56.000Z'; });
assertHashChanges('document filename', (template) => { template.documents[0].filename = 'safety-policy.pdf'; });
assertHashChanges('source document bytes', (_template, sources) => {
  sources['document-b'] = sha256(Buffer.from('changed policy source bytes'));
});

test('requires exact SHA-256 coverage for every document UUID', () => {
  const missing = digests();
  delete missing['document-b'];
  assert.throws(() => normalizeTemplateSnapshot(fixture(), missing), /missing: document-b/);
  assert.throws(() => normalizeTemplateSnapshot(fixture(), { ...digests(), unexpected: sha256('extra') }), /extra: unexpected/);
  assert.throws(() => normalizeTemplateSnapshot(fixture(), { ...digests(), 'document-a': 'not-a-digest' }), /64-character SHA-256/);
});

test('rejects sensitive URLs, slugs, credentials, and non-JSON values inside included values', () => {
  const cases = [
    (template) => { template.preferences.callback_url = 'https://private.invalid/hook'; },
    (template) => { template.schema[0].slug = 'private-document-slug'; },
    (template) => { template.variables_schema.start_date.credentials = 'secret'; },
    (template) => { template.preferences.note = 'Bearer abc123'; },
    (template) => { template.preferences.invalid = undefined; },
  ];
  for (const mutate of cases) {
    const template = fixture();
    mutate(template);
    assert.throws(() => normalizeTemplateSnapshot(template, digests()), /private|credential|must contain only|must be an object/);
  }
});

test('validates strict template, field, area, and relationship types', () => {
  const wrongId = fixture();
  wrongId.id = '42';
  assert.throws(() => normalizeTemplateSnapshot(wrongId, digests()), /template.id must be/);

  const zeroTemplateId = fixture();
  zeroTemplateId.id = 0;
  assert.throws(() => normalizeTemplateSnapshot(zeroTemplateId, digests()), /template.id must be a positive safe integer/);

  const zeroDocumentId = fixture();
  zeroDocumentId.documents[0].id = 0;
  assert.throws(() => normalizeTemplateSnapshot(zeroDocumentId, digests()), /documents\[0\]\.id must be a positive safe integer/);

  const arrayVariablesSchema = fixture();
  arrayVariablesSchema.variables_schema = [];
  assert.throws(() => normalizeTemplateSnapshot(arrayVariablesSchema, digests()), /variables_schema must be an object/);

  const nullVariablesSchema = fixture();
  nullVariablesSchema.variables_schema = null;
  assert.throws(() => normalizeTemplateSnapshot(nullVariablesSchema, digests()), /variables_schema must be an object/);

  const wrongRequired = fixture();
  wrongRequired.fields[0].required = 1;
  assert.throws(() => normalizeTemplateSnapshot(wrongRequired, digests()), /required must be a boolean/);

  const wrongArea = fixture();
  wrongArea.fields[0].areas[0].x = '0.2';
  assert.throws(() => normalizeTemplateSnapshot(wrongArea, digests()), /x must be a finite number/);

  const orphanField = fixture();
  orphanField.fields[0].submitter_uuid = 'missing-submitter';
  assert.throws(() => normalizeTemplateSnapshot(orphanField, digests()), /must reference a template submitter/);
});
