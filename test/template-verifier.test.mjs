import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import {
  PDFJS_NODE_ASSETS,
  entriesForScope,
  inspectInkBands,
  liveExpectation,
  parseVerifierArgs,
  stampedReflowUuidMap,
  validateActiveInventory,
  validateFirstPageBodyInk,
  validateProviderDocumentTopology,
} from '../pipeline/template-verifier.mjs';
import { buildProviderAttestation } from '../pipeline/provider-attestation.mjs';

test('first-page verifier ignores a wide footer and rejects overflow, narrow, or shifted body ink', () => {
  const width = 816;
  const height = 1056;
  const render = (bodyX, bodyWidth) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000';
    context.fillRect(bodyX, 180, bodyWidth, 20);
    context.fillRect(54, 1010, 708, 2); // final packet footer rule, 86.8% wide
    return inspectInkBands(context, width, height);
  };

  const expected = render(144, 552);
  const fullSpan = (expected.full.maxX - expected.full.minX) / width;
  assert.ok(fullSpan > 0.86, `expected footer to make full-page span wide, got ${fullSpan}`);
  assert.doesNotThrow(() => validateFirstPageBodyInk(expected));
  assert.throws(() => validateFirstPageBodyInk(render(20, 676)), /body ink bounds/); // left overflow
  assert.throws(() => validateFirstPageBodyInk(render(144, 650)), /body ink bounds/); // right overflow
  assert.throws(() => validateFirstPageBodyInk(render(240, 300)), /body ink bounds/); // narrow
  assert.throws(() => validateFirstPageBodyInk(render(180, 552)), /body ink bounds/); // shifted
});

test('pdfjs verifier assets point at installed fonts and wasm decoders', () => {
  assert.ok(PDFJS_NODE_ASSETS.standardFontDataUrl.endsWith('/'));
  assert.ok(PDFJS_NODE_ASSETS.wasmUrl.endsWith('/'));
  assert.ok(existsSync(PDFJS_NODE_ASSETS.standardFontDataUrl));
  assert.ok(existsSync(PDFJS_NODE_ASSETS.wasmUrl));
  assert.equal(PDFJS_NODE_ASSETS.useSystemFonts, false);
  assert.equal(PDFJS_NODE_ASSETS.isImageDecoderSupported, false);
});

test('provider raw digest is captured before PDF.js can take ownership of response bytes', () => {
  const source = readFileSync(new URL('../pipeline/verify-templates.mjs', import.meta.url), 'utf8');
  const inspect = source.slice(source.indexOf('async function inspectPdf'), source.indexOf('const inventory ='));
  assert.ok(inspect.indexOf('const rawSha256 = sha256(bytes)') < inspect.indexOf('getDocument({ data: bytes'));
  assert.match(inspect, /return \{ sha256: rawSha256, fingerprint, pages \}/);
});

test('verifier scope targets the explicit four-template W-2 release', () => {
  const current = [
    { slug: 'standalone' },
    { slug: 'w2-initial-packet-v3', sources: [{ slug: 'a' }, { slug: 'b' }] },
    { slug: 'w2-initial-packet-es-v3', sources: [{ slug: 'a-es' }, { slug: 'b-es' }] },
    { slug: 'safety-training-roster' },
    { slug: 'safety-training-roster-es' },
  ];
  assert.deepEqual(parseVerifierArgs([]), { scope: 'current' });
  assert.deepEqual(parseVerifierArgs(['--scope', 'w2-release']), { scope: 'w2-release' });
  assert.deepEqual(parseVerifierArgs(['--scope=w2-cutover']), { scope: 'w2-cutover' });
  assert.deepEqual(parseVerifierArgs(['--scope=all-live']), { scope: 'all-live' });
  assert.deepEqual(
    entriesForScope({ current, retainedLegacy: [{ slug: 'legacy' }] }, 'w2-release').map((entry) => entry.slug),
    ['w2-initial-packet-v3', 'w2-initial-packet-es-v3', 'safety-training-roster', 'safety-training-roster-es'],
  );
  const retainedLegacy = [
    { slug: 'w2-initial-packet-v2' },
    { slug: 'w2-initial-packet-es-v2' },
    { slug: 'legacy' },
  ];
  assert.deepEqual(
    entriesForScope({ current, retainedLegacy }, 'w2-cutover').map((entry) => entry.slug),
    [
      'w2-initial-packet-v3', 'w2-initial-packet-es-v3',
      'safety-training-roster', 'safety-training-roster-es',
      'w2-initial-packet-v2', 'w2-initial-packet-es-v2',
    ],
  );
  assert.deepEqual(
    entriesForScope({ current, retainedLegacy }, 'all-live').at(-1),
    { slug: 'legacy' },
  );
  assert.throws(() => parseVerifierArgs(['--scope', 'composites']), /current, w2-release, w2-cutover, or all-live/);
});

test('v3 verifier requires 15 ordered measured provider documents and local field pages', () => {
  const fingerprint = (pageCount, digit) => ({
    algorithm: 'hamilton-pdf-semantic-visual-v1', scale: 2, pageCount,
    semanticSha256: digit.repeat(64), visualSha256: digit.repeat(64), operatorSha256: digit.repeat(64),
    pages: Array.from({ length: pageCount }, () => ({})),
  });
  const sources = Array.from({ length: 15 }, (_, index) => {
    const pageCount = index === 14 ? 12 : 5;
    return {
      order: index,
      slug: `source-${index + 1}`,
      attachmentFilename: `source-${index + 1}.pdf`,
      attachmentSha256: String(index % 10).repeat(64),
      attachmentFingerprint: fingerprint(pageCount, String((index % 9) + 1)),
      pageCount,
    };
  });
  const schema = sources.map((source, index) => ({
    name: source.attachmentFilename.replace(/\.pdf$/, ''),
    attachment_uuid: `doc-${index + 1}`,
  }));
  const documents = schema.map((document, index) => ({
    uuid: document.attachment_uuid,
    filename: sources[index].attachmentFilename,
  }));
  const inspections = sources.map((source) => ({
    sha256: source.attachmentSha256,
    fingerprint: source.attachmentFingerprint,
    pages: Array.from({ length: source.pageCount }, () => ({ full: { ink: 1 } })),
  }));
  const entry = {
    slug: 'packet-v3', title: 'Packet v3', version: 3,
    providerDocuments: 15, pageCount: 82, orderedSourceAttachments: true,
  };
  const expectedField = {
    id: 'anchor-1', sourceSlug: 'source-15', attachmentOrder: 14, sourcePage: 11,
    owner: 'worker', type: 'signature', x: 0.1, y: 0.2, w: 0.3, h: 0.04,
  };
  const measured = { slug: entry.slug, layoutSha256: 'a'.repeat(64), sources, fields: [expectedField] };
  const template = {
    id: 380,
    name: entry.title,
    schema,
    documents,
    submitters: [{ uuid: 'worker-role', name: 'Worker' }],
    fields: [{
      uuid: 'field-1', type: 'signature', submitter_uuid: 'worker-role',
      areas: [{ attachment_uuid: 'doc-15', page: 11, x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
    }],
  };
  const attestationInput = {
    slug: entry.slug,
    registryVersion: entry.version,
    templateId: template.id,
    templateName: template.name,
    layoutSha256: measured.layoutSha256,
    reflowSha256: 'b'.repeat(64),
    documents: documents.map((document, index) => ({
      uuid: document.uuid,
      filename: document.filename,
      localRawSha256: sources[index].attachmentSha256,
      providerRawSha256: inspections[index].sha256,
      fingerprint: inspections[index].fingerprint,
    })),
  };
  const attestation = buildProviderAttestation([
    attestationInput,
    { ...attestationInput, slug: 'packet-es-v3', templateId: 381, templateName: 'Packet ES v3' },
  ]);
  const attestationEntry = attestation.entries[0];
  const mismatchedAttestationInput = structuredClone(attestationInput);
  mismatchedAttestationInput.documents[0].providerRawSha256 = 'c'.repeat(64);
  assert.throws(() => buildProviderAttestation([
    mismatchedAttestationInput,
    { ...mismatchedAttestationInput, slug: 'packet-es-v3', templateId: 381, templateName: 'Packet ES v3' },
  ]), /byte-identical to the approved local source/);
  const uuidByFieldId = new Map([['anchor-1', 'field-1']]);
  const validate = (candidate = template) => validateProviderDocumentTopology({
    entry, template: candidate, measured, inspections, uuidByFieldId, attestation, attestationEntry,
  });
  assert.deepEqual(
    validate(),
    { totalPages: 82, attachmentUuids: schema.map((document) => document.attachment_uuid) },
  );
  const rawDrift = structuredClone(inspections);
  rawDrift[0].sha256 = 'c'.repeat(64);
  assert.throws(() => validateProviderDocumentTopology({
    entry, template, measured, inspections: rawDrift, uuidByFieldId, attestation, attestationEntry,
  }), /raw bytes\/identity differ from the approved local source/);
  assert.throws(() => validateProviderDocumentTopology({
    entry, template, measured, inspections, uuidByFieldId,
  }), /provider attestation structure is invalid/);
  // Each mutation preserves the synthetic semantic/visual fingerprint. Exact raw identity
  // must still reject serialization, catalog/action, page-box, and annotation-hierarchy drift.
  for (const [mutationClass, rawSha256] of [
    ['raw serialization', 'c'.repeat(64)],
    ['catalog/action tree', 'd'.repeat(64)],
    ['page box', 'e'.repeat(64)],
    ['annotation hierarchy', 'f'.repeat(64)],
  ]) {
    const changed = structuredClone(inspections);
    changed[0].sha256 = rawSha256;
    assert.throws(() => validateProviderDocumentTopology({
      entry, template, measured, inspections: changed, uuidByFieldId, attestation, attestationEntry,
    }), /raw bytes\/identity differ from the approved local source/, mutationClass);
  }
  const operatorDrift = structuredClone(inspections);
  operatorDrift[0].fingerprint.operatorSha256 = 'c'.repeat(64);
  assert.throws(() => validateProviderDocumentTopology({
    entry, template, measured, inspections: operatorDrift, uuidByFieldId, attestation, attestationEntry,
  }), /diagnostic fingerprint differs/);

  for (const [mutate, pattern] of [
    [(copy) => { copy.fields[0].areas[0].page = 10; }, /attachment\/local page\/geometry/],
    [(copy) => { copy.fields[0].areas[0].x = 0.11; }, /attachment\/local page\/geometry/],
    // doc-14 is intentionally fieldless; a merely in-range page must still fail exact ownership.
    [(copy) => { copy.fields[0].areas[0].attachment_uuid = 'doc-14'; copy.fields[0].areas[0].page = 0; }, /attachment\/local page\/geometry/],
  ]) {
    const changed = structuredClone(template);
    mutate(changed);
    assert.throws(() => validate(changed), pattern);
  }
  const duplicateUuid = structuredClone(template);
  duplicateUuid.schema[1].attachment_uuid = duplicateUuid.schema[0].attachment_uuid;
  assert.throws(() => validate(duplicateUuid), /UUID\/order differs/);
  const reordered = structuredClone(template);
  [reordered.documents[0], reordered.documents[1]] = [reordered.documents[1], reordered.documents[0]];
  assert.throws(() => validate(reordered), /UUID\/order differs/);
});

test('stamped reflow mapping requires exact unique field and UUID coverage', () => {
  const fields = [{ id: 'a' }, { id: 'b' }];
  const html = '<span id="a" data-hx-uuid="u1"></span><span id="b" data-hx-uuid="u2"></span>';
  assert.deepEqual([...stampedReflowUuidMap(html, fields)], [['a', 'u1'], ['b', 'u2']]);
  assert.throws(() => stampedReflowUuidMap(html.replace(' data-hx-uuid="u2"', ''), fields), /present and unique/);
  assert.throws(() => stampedReflowUuidMap(html.replace('u2', 'u1'), fields), /present and unique/);
});

test('retained live templates may pin historical field expectations without changing build truth', () => {
  assert.deepEqual(
    liveExpectation({
      fields: 34,
      owners: { worker: 31, hamilton: 3 },
      liveFields: 33,
      liveOwners: { worker: 30, hamilton: 3 },
    }),
    { fields: 33, owners: { worker: 30, hamilton: 3 } },
  );
  assert.deepEqual(
    liveExpectation({ fields: 5, owners: { hamilton: 5 } }),
    { fields: 5, owners: { hamilton: 5 } },
  );
});

test('active inventory allows retained legacy but rejects source-only or unknown identities', () => {
  const allowed = [{ title: 'Current' }, { title: 'Retained Legacy' }];
  const sourceOnly = [{ title: 'Spanish Source Only' }];
  assert.doesNotThrow(() => validateActiveInventory(
    [{ name: 'Current' }, { name: 'Retained Legacy' }],
    allowed,
    sourceOnly,
  ));
  assert.throws(
    () => validateActiveInventory([{ name: 'Spanish Source Only' }], allowed, sourceOnly),
    /source-only templates must not be active/,
  );
  assert.throws(
    () => validateActiveInventory([{ name: 'Unknown' }], allowed, sourceOnly),
    /unexpected active templates/,
  );
});
