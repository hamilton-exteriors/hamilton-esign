import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertNoBlockingSubmissions,
  requireProviderConditionalMutation,
  verifyCreatedTemplateReadback,
  withCreatedTemplateCleanup,
} from '../pipeline/template-mutation-safety.mjs';

function createdFixture() {
  const digest = 'a'.repeat(64);
  const schema = [{ name: 'packet.pdf', attachment_uuid: 'doc-1' }];
  const submitters = [
    { uuid: 'role-worker', name: 'Worker' },
    { uuid: 'role-employer', name: 'Hamilton' },
  ];
  const measuredFields = [
    { id: 'f1', owner: 'worker', type: 'signature', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
    { id: 'f2', owner: 'employer', type: 'date', page: 1, x: 0.5, y: 0.6, w: 0.2, h: 0.03 },
  ];
  const fields = measuredFields.map((field, index) => ({
    uuid: `field-${index + 1}`,
    name: index === 0 ? 'Policy acknowledgment' : field.id,
    description: index === 0 ? 'Safety policy acknowledgment' : undefined,
    required: index === 0,
    type: field.type,
    submitter_uuid: field.owner === 'worker' ? 'role-worker' : 'role-employer',
    areas: [{
      page: field.page, x: field.x, y: field.y, w: field.w, h: field.h, attachment_uuid: 'doc-1',
    }],
  }));
  return {
    saved: {
      name: 'Packet',
      id: 123,
      schema: structuredClone(schema),
      documents: [{ uuid: 'doc-1', filename: 'packet.pdf' }],
      submitters: structuredClone(submitters),
      fields: structuredClone(fields),
    },
    expectedId: 123,
    expectedName: 'Packet',
    expectedSchema: schema,
    expectedDocuments: [{ uuid: 'doc-1', filename: 'packet.pdf', sha256: digest }],
    savedDocumentDigests: new Map([['doc-1', digest]]),
    expectedSubmitters: submitters,
    expectedFields: fields,
    measuredFields,
    ownerUuidByOwner: { worker: 'role-worker', employer: 'role-employer' },
  };
}

test('created-template readback proves document, UUID, type, owner, geometry, and measured mapping', () => {
  const fixture = createdFixture();
  assert.deepEqual(verifyCreatedTemplateReadback(fixture), { f1: 'field-1', f2: 'field-2' });

  for (const mutate of [
    (copy) => { copy.saved.id = 124; },
    (copy) => { copy.saved.schema[0].attachment_uuid = 'other-doc'; },
    (copy) => { copy.saved.fields[0].uuid = 'other-field'; },
    (copy) => { copy.saved.fields[0].type = 'text'; },
    (copy) => { copy.saved.fields[0].submitter_uuid = 'role-employer'; },
    (copy) => { copy.saved.fields[0].areas[0].x = 0.11; },
    (copy) => { copy.saved.fields[0].areas[0].page = 1; },
    (copy) => { copy.saved.fields[0].areas[0].attachment_uuid = 'other-doc'; },
  ]) {
    const copy = structuredClone(fixture);
    mutate(copy);
    assert.throws(() => verifyCreatedTemplateReadback(copy), /identity|document UUID|omitted field UUID|type, role ownership, geometry, or document UUID/);
  }
});

test('created-template readback requires exact raw bytes and compares operator diagnostics', () => {
  const fixture = createdFixture();
  const fingerprint = {
    algorithm: 'hamilton-pdf-semantic-visual-v1', scale: 2, pageCount: 2,
    semanticSha256: '1'.repeat(64), visualSha256: '2'.repeat(64), operatorSha256: '3'.repeat(64),
    pages: [{}, {}],
  };
  fixture.expectedDocuments[0].fingerprint = fingerprint;
  delete fixture.savedDocumentDigests;
  fixture.savedDocumentInspections = new Map([['doc-1', {
    rawSha256: fixture.expectedDocuments[0].sha256,
    fingerprint: structuredClone(fingerprint),
  }]]);
  assert.deepEqual(verifyCreatedTemplateReadback(fixture), { f1: 'field-1', f2: 'field-2' });

  fixture.savedDocumentInspections.get('doc-1').rawSha256 = 'b'.repeat(64);
  assert.throws(() => verifyCreatedTemplateReadback(fixture), /raw digest changed/);
  fixture.savedDocumentInspections.get('doc-1').rawSha256 = fixture.expectedDocuments[0].sha256;
  fixture.savedDocumentInspections.get('doc-1').fingerprint.operatorSha256 = '4'.repeat(64);
  assert.throws(() => verifyCreatedTemplateReadback(fixture), /diagnostic fingerprint changed/);
});

test('created-template readback canonicalizes only a stripped final .pdf suffix', () => {
  const fixture = createdFixture();
  fixture.saved.schema[0].name = 'packet';
  fixture.saved.documents[0].filename = 'packet';
  assert.deepEqual(verifyCreatedTemplateReadback(fixture), { f1: 'field-1', f2: 'field-2' });
  for (const name of [' packet', 'folder/packet.pdf', 'packet.PDF', 'packet.pdf.pdf']) {
    const changed = createdFixture();
    changed.saved.schema[0].name = name;
    assert.throws(() => verifyCreatedTemplateReadback(changed), /provider PDF name|document UUID\/name\/order/);
  }
});

test('created-template readback accepts 15 ordered documents including fieldless sources', () => {
  const fixture = createdFixture();
  const schema = Array.from({ length: 15 }, (_, index) => ({
    name: `source-${index + 1}.pdf`,
    attachment_uuid: `doc-${index + 1}`,
  }));
  const digestEntries = schema.map((document, index) => [document.attachment_uuid, String(index % 10).repeat(64)]);
  fixture.expectedSchema = schema;
  fixture.saved.schema = structuredClone(schema);
  fixture.expectedDocuments = schema.map((document, index) => ({
    uuid: document.attachment_uuid,
    filename: document.name,
    sha256: digestEntries[index][1],
  }));
  fixture.saved.documents = fixture.expectedDocuments.map(({ uuid, filename }) => ({ uuid, filename }));
  fixture.savedDocumentDigests = new Map(digestEntries);
  fixture.expectedFields[1].areas[0].attachment_uuid = 'doc-15';
  fixture.saved.fields[1].areas[0].attachment_uuid = 'doc-15';
  assert.deepEqual(verifyCreatedTemplateReadback(fixture), { f1: 'field-1', f2: 'field-2' });

  const reordered = structuredClone(fixture);
  [reordered.saved.documents[0], reordered.saved.documents[1]] =
    [reordered.saved.documents[1], reordered.saved.documents[0]];
  assert.throws(() => verifyCreatedTemplateReadback(reordered), /UUID\/filename\/order changed/);

  const changedDigest = structuredClone(fixture);
  changedDigest.savedDocumentDigests.set('doc-8', 'f'.repeat(64));
  assert.throws(() => verifyCreatedTemplateReadback(changedDigest), /document 7 raw digest changed/);
});

test('created-template readback rejects a required policy acknowledgment made optional', () => {
  const fixture = createdFixture();
  fixture.saved.fields[0].required = false;
  assert.throws(
    () => verifyCreatedTemplateReadback(fixture),
    /f1: provider field required flag changed/,
  );
});

test('created-template readback rejects field name and description drift', () => {
  const nameDrift = createdFixture();
  nameDrift.saved.fields[0].name = 'Policy acknowledgement';
  assert.throws(
    () => verifyCreatedTemplateReadback(nameDrift),
    /f1: provider field name changed/,
  );

  const descriptionDrift = createdFixture();
  descriptionDrift.saved.fields[0].description = 'General safety policy';
  assert.throws(
    () => verifyCreatedTemplateReadback(descriptionDrift),
    /f1: provider field description changed/,
  );
});

test('created-template readback canonicalizes only an absent optional description', () => {
  const fixture = createdFixture();
  delete fixture.saved.fields[1].description;
  fixture.expectedFields[1].description = null;
  assert.deepEqual(verifyCreatedTemplateReadback(fixture), { f1: 'field-1', f2: 'field-2' });
});

test('active target submission blocks and missing safety properties fail closed', async () => {
  const targetTemplateIds = new Set([42]);
  await assert.rejects(
    assertNoBlockingSubmissions({
      submissions: [{ id: 7, archived_at: null, template_id: 42 }],
      targetTemplateIds,
      readSubmission: async () => ({
        id: 7, archived_at: null, template_id: 42, template_fields: [], template_schema: [],
      }),
    }),
    /is active for template 42/,
  );
  await assert.rejects(
    assertNoBlockingSubmissions({
      submissions: [{ id: 8, archived_at: null, template_id: 42 }],
      targetTemplateIds,
      readSubmission: async () => ({ id: 8, archived_at: null, template_id: 42 }),
    }),
    /missing template snapshot properties/,
  );
  await assert.rejects(
    assertNoBlockingSubmissions({
      submissions: [{ id: 9, template_id: 99 }],
      targetTemplateIds,
      readSubmission: async () => ({}),
    }),
    /missing archived_at/,
  );
});

test('only positively archived or unrelated submissions are safe', async () => {
  let reads = 0;
  await assert.doesNotReject(assertNoBlockingSubmissions({
    submissions: [
      { id: 1, archived_at: '2026-01-01T00:00:00Z' },
      { id: 2, archived_at: null, template_id: 99 },
      { id: 3, archived_at: null },
    ],
    targetTemplateIds: new Set([42]),
    readSubmission: async () => {
      reads += 1;
      return {
        id: 3, archived_at: null, template_id: 99, template_fields: [], template_schema: [],
      };
    },
  }));
  assert.equal(reads, 1);
});

test('post-create reflow/stamping failure cleans up every remote template in reverse order', async () => {
  const cleaned = [];
  await assert.rejects(
    withCreatedTemplateCleanup(async (trackCreated) => {
      trackCreated(101);
      trackCreated(102);
      throw new Error('stamping failed');
    }, { cleanupTemplate: async (id) => cleaned.push(id) }),
    /archived 2 partial template\(s\): stamping failed/,
  );
  assert.deepEqual(cleaned, [102, 101]);
});

test('cleanup transaction reports cleanup failure without hiding creation failure', async () => {
  await assert.rejects(
    withCreatedTemplateCleanup(async (trackCreated) => {
      trackCreated(101);
      throw new Error('reflow failed');
    }, { cleanupTemplate: async () => { throw new Error('archive unavailable'); } }),
    /template creation failed \(reflow failed\); partial cleanup failed: 101: archive unavailable/,
  );
});

test('provider capability check documents that local read-compare is not CAS', () => {
  assert.throws(
    () => requireProviderConditionalMutation({ conditionalMutation: false, reason: 'unconditional PUT only' }),
    /unsafe in-place template migration is disabled: unconditional PUT only/,
  );
});

test('--apply for both migration CLIs fails before secrets or network access', () => {
  for (const script of ['migrate-generated-templates.mjs', 'migrate-iipp.mjs']) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL(`../pipeline/${script}`, import.meta.url)),
      '--apply',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCUSEAL_API_KEY: '',
        DOCUSEAL_EMAIL: '',
        DOCUSEAL_PASSWORD: '',
      },
    });
    assert.notEqual(result.status, 0, script);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsafe in-place template migration is disabled/);
  }
});
