import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createDocusealClient } from '../pipeline/docuseal-api.mjs';
import {
  CURRENT_TEMPLATE_REGISTRY,
  SOURCE_ONLY_TEMPLATE_REGISTRY,
  requireUniqueActiveTemplate,
  DEFAULT_DOCUMENT_SLUGS,
  TEMPLATE_BY_SLUG,
  orderedSources,
} from '../pipeline/registry.mjs';
import { sourceManifest, validateManifestEntry, assertCurrentSources, validateMeasuredBuild, measuredLayoutDigest, sha256 } from '../pipeline/build-manifest.mjs';
import { deterministicPdfBytes, packetFooterDescriptors } from '../pipeline/pdf-determinism.mjs';
import { fetchStatutoryPdf, locateStatutoryFooterMasks, orderStatutoryTextItems, statutoryPdfToReflow } from '../pipeline/statutory-assets.mjs';
import { matchGeneratedFields } from '../pipeline/field-match.mjs';
import {
  appendOrderedSourceUploads,
  bytesSha256,
  canonicalProviderPdfName,
  mapFieldsToSourceAttachments,
  orderedSourceUploads,
  providerFieldGeometry,
} from '../pipeline/packet-topology.mjs';
import { packetFor, validate } from '../pipeline/worker-types.mjs';
import { scopeCss, assertScoped, normalizeReflowTables, scopeDocumentLanguages, classify } from '../pipeline/build-docs.mjs';
import { stampReflowAnchors } from '../pipeline/reflow-anchor.mjs';
import { validateGeneratedGeometry } from '../pipeline/field-geometry.mjs';
import { planIippMigration, buildMigratedFields, assertIippPostflight } from '../pipeline/migrate-iipp.mjs';

const secrets = { url: 'https://docuseal.test', publicUrl: 'https://sign.test', apiKey: 'test' };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('DocuSeal client rejects non-2xx and non-JSON success bodies', async () => {
  const denied = createDocusealClient(secrets, async () => jsonResponse({ error: 'no' }, 401));
  await assert.rejects(denied.request('/api/templates'), /failed \(401\)/);

  const html = createDocusealClient(secrets, async () => new Response('<html>', { status: 200 }));
  await assert.rejects(html.request('/api/templates'), /non-JSON/);
});

test('DocuSeal pagination collects every page and stops', async () => {
  const calls = [];
  const client = createDocusealClient(secrets, async (url) => {
    const after = new URL(url).searchParams.get('after');
    calls.push(after);
    return jsonResponse(after == null
      ? { data: [{ id: 1 }, { id: 2 }], pagination: { next: 2 } }
      : { data: [{ id: 3 }], pagination: { next: 3 } });
  });
  const rows = await client.listAll('/api/templates', { limit: 2 });
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(calls, [null, '2']);
});

test('PDF normalization removes wall-clock metadata from retained build intermediates', async () => {
  const makePdf = async (date) => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    pdf.setCreationDate(date);
    pdf.setModificationDate(date);
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  };
  const left = await deterministicPdfBytes(await makePdf(new Date('2026-01-01T01:02:03Z')), { title: 'Same' });
  const right = await deterministicPdfBytes(await makePdf(new Date('2026-07-30T04:05:06Z')), { title: 'Same' });
  assert.equal(sha256(left), sha256(right));
});

test('template resolution fails on zero or duplicate active names', () => {
  const template = { id: 1, name: 'Employment Agreement', archived_at: null };
  assert.equal(requireUniqueActiveTemplate([template], template.name), template);
  assert.throws(() => requireUniqueActiveTemplate([], template.name), /found 0/);
  assert.throws(() => requireUniqueActiveTemplate([template, { ...template, id: 2 }], template.name), /found 2/);
  assert.ok(DEFAULT_DOCUMENT_SLUGS.includes('independent-contractor-agreement'));
  assert.ok(DEFAULT_DOCUMENT_SLUGS.includes('w2-initial-packet-v3'));
  assert.ok(!DEFAULT_DOCUMENT_SLUGS.includes('iipp-es'));
  assert.ok(!DEFAULT_DOCUMENT_SLUGS.includes('fall-protection-program-es'));
  assert.deepEqual(
    SOURCE_ONLY_TEMPLATE_REGISTRY.map((entry) => entry.slug).sort(),
    ['fall-protection-program-es', 'iipp-es'],
  );
  assert.ok(SOURCE_ONLY_TEMPLATE_REGISTRY.every((entry) => entry.liveExpected === false));
  assert.ok(CURRENT_TEMPLATE_REGISTRY.every((entry) => !entry.sourceOnly && entry.liveExpected !== false));
  assert.equal(DEFAULT_DOCUMENT_SLUGS.length, 10);
});

test('composite build manifest pins markdown and statutory PDF sources and detects drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hamilton-manifest-'));
  mkdirSync(join(dir, 'statutory'));
  const entry = {
    slug: 'synthetic-composite', title: 'Synthetic Composite', version: 2,
    fields: 2, owners: { worker: 1, hamilton: 1 },
    sources: [
      { kind: 'markdown', slug: 'agreement' },
      { kind: 'pdf', slug: 'statutory-notice', title: 'Notice', language: 'en', url: 'https://www.dir.ca.gov/notice.pdf' },
      { kind: 'markdown', slug: 'program' },
    ],
  };
  writeFileSync(join(dir, 'agreement.md'), 'agreement\n');
  writeFileSync(join(dir, 'program.md'), 'program\n');
  const statutory = Buffer.from('%PDF- synthetic statutory bytes');
  writeFileSync(join(dir, 'statutory', 'statutory-notice.pdf'), statutory);
  const manifest = sourceManifest(entry, dir, new Map([[
    'statutory-notice', { sha256: sha256(statutory), pageCount: 1 },
  ]]));
  assert.deepEqual(manifest.sources.map((source) => source.slug), ['agreement', 'statutory-notice', 'program']);
  assert.doesNotThrow(() => validateManifestEntry(manifest, entry));
  assert.doesNotThrow(() => assertCurrentSources(manifest, entry, dir, dir));
  const pdf = Buffer.from('synthetic composed PDF');
  const measured = {
    ...manifest,
    sources: manifest.sources.map((source, index) => ({ ...source, outputStartPage: index, pageCount: 1 })),
    pageCount: 3,
    pdfSha256: sha256(pdf),
    fields: [
      { id: 'w1', owner: 'worker', sourceSlug: 'agreement', page: 0 },
      { id: 'h1', owner: 'employer', sourceSlug: 'program', page: 2 },
    ],
  };
  measured.layoutSha256 = measuredLayoutDigest(measured);
  assert.doesNotThrow(() => validateMeasuredBuild(measured, entry, dir, dir, pdf));
  assert.throws(() => validateMeasuredBuild({ ...measured, pdfSha256: 'a'.repeat(64) }, entry, dir, dir, pdf), /PDF digest/);
  const wrongOwner = structuredClone(measured);
  wrongOwner.fields[0].owner = 'employer';
  assert.throws(() => validateMeasuredBuild(wrongOwner, entry, dir, dir, pdf), /owns .* expected/);
  const wrongSource = structuredClone(measured);
  wrongSource.fields[0].sourceSlug = 'not-a-source';
  assert.throws(() => validateMeasuredBuild(wrongSource, entry, dir, dir, pdf), /invalid source ownership/);
  const wrongOrder = structuredClone(measured);
  wrongOrder.sources[1].outputStartPage = 0;
  assert.throws(() => validateMeasuredBuild(wrongOrder, entry, dir, dir, pdf), /page range is not contiguous/);
  const fieldOutsideSource = structuredClone(measured);
  fieldOutsideSource.fields[0].page = 2;
  assert.throws(() => validateMeasuredBuild(fieldOutsideSource, entry, dir, dir, pdf), /outside its source page range/);
  writeFileSync(join(dir, 'program.md'), 'changed source\n');
  assert.throws(() => assertCurrentSources(manifest, entry, dir, dir), /canonical source changed after build/);
  const reordered = structuredClone(manifest);
  reordered.sources.reverse();
  assert.throws(() => validateManifestEntry(reordered, entry), /ordered registry source/);
});

test('W-2 composites put the receipt acknowledgment after all statutory PDFs and four programs', () => {
  for (const slug of ['w2-initial-packet-v3', 'w2-initial-packet-es-v3']) {
    const sources = orderedSources(TEMPLATE_BY_SLUG.get(slug));
    assert.equal(sources.filter((source) => source.kind === 'pdf').length, 8);
    const sourceSlugs = sources.map((source) => source.slug);
    const policySlug = slug.includes('-es-') ? 'policy-acknowledgment-es' : 'policy-acknowledgment';
    const expectedPrograms = slug.includes('-es-')
      ? ['iipp-es', 'heat-illness-prevention-plan-es', 'fall-protection-program-es', 'code-of-safe-practices']
      : ['iipp', 'heat-illness-prevention-plan', 'fall-protection-program', 'code-of-safe-practices'];
    assert.deepEqual(sourceSlugs.slice(-5), [...expectedPrograms, policySlug]);
    assert.ok(sources.slice(2, -5).every((source) => source.kind === 'pdf'));
    assert.ok(!sourceSlugs.some((source) => /safety-training-roster/.test(source)));
  }
});

test('statutory PDF ingestion validates authoritative bytes and emits actual reflow text', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText('California statutory notice content', { x: 72, y: 720, size: 12, font });
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const dir = mkdtempSync(join(tmpdir(), 'hamilton-statutory-'));
  const source = {
    kind: 'pdf', slug: 'statutory-test', title: 'Statutory Test', language: 'en',
    url: 'https://www.dir.ca.gov/test.pdf',
  };
  const expected = { slug: source.slug, url: source.url, sha256: sha256(bytes), bytes: bytes.length, pageCount: 1 };
  const fetchPdf = async () => new Response(bytes, {
    status: 200, headers: { 'content-type': 'application/pdf' },
  });
  const artifact = await fetchStatutoryPdf(source, dir, expected, fetchPdf);
  assert.equal(artifact.sha256, sha256(bytes));
  const reflow = await statutoryPdfToReflow(source, artifact.bytes);
  assert.equal(reflow.pageCount, 1);
  assert.match(reflow.html, /California statutory notice content/);
  await assert.rejects(
    fetchStatutoryPdf({ ...source, url: 'https://example.com/test.pdf' }, dir,
      { ...expected, url: 'https://example.com/test.pdf' }, fetchPdf),
    /approved authoritative host/,
  );
  await assert.rejects(
    fetchStatutoryPdf(source, dir, expected, async () => new Response('<html>no</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })),
    /not a PDF/,
  );
});

test('statutory reflow preserves two-column reading order and rejects any unreadable page', async () => {
  const viewport = { width: 600, scale: 1, convertToViewportPoint: (x, y) => [x, 800 - y] };
  const item = (str, x, y) => ({ str, width: 60, transform: [1, 0, 0, 1, x, y] });
  const ordered = orderStatutoryTextItems([
    item('R1', 360, 700), item('L2', 60, 680), item('R2', 360, 680), item('L1', 60, 700),
    item('R3', 360, 660), item('L4', 60, 640), item('R4', 360, 640), item('L3', 60, 660),
  ], viewport);
  assert.equal(ordered.columns, 2);
  assert.deepEqual(ordered.lines, ['L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3', 'R4']);

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText('Readable first statutory page content', { x: 72, y: 720, font });
  pdf.addPage([612, 792]);
  const source = { slug: 'statutory-two-page-test', title: 'Test', language: 'en' };
  await assert.rejects(statutoryPdfToReflow(source, Buffer.from(await pdf.save())), /page 2 has no complete readable text layer/);
});

test('Spanish DE-2515 cached brochure follows its real folded reader order', async () => {
  const bytes = readFileSync(new URL('../statutory/statutory-de-2515-es.pdf', import.meta.url));
  const source = { slug: 'statutory-de-2515-es', title: 'DE 2515 Seguro de Incapacidad', language: 'es' };
  const reflow = await statutoryPdfToReflow(source, bytes);
  assert.equal(reflow.pageCount, 2);
  assert.match(reflow.html, /data-columns="4"/);
  assert.match(reflow.html, /data-reader-order="p1c4,p1c2,p1c1,p2c1,p2c2,p2c3,p2c4,p1c3"/);

  // Literal phrases from the immutable agency brochure pin the semantic sequence,
  // rather than merely proving that a generic left-to-right column sorter ran.
  const phrases = [
    'Disposiciones',
    '¿Qué es la incapacidad?',
    '¿Cuáles son mis beneficios',
    '¿Cómo solicito los',
    '¿Cuál es el siguiente',
    '¿Cómo se calculan mis',
    '¿Cuáles son mis',
    'Este folleto únicamente ofrece información general',
  ];
  const positions = phrases.map((phrase, index) =>
    reflow.html.indexOf(phrase, index === 6 ? reflow.html.indexOf('¿Cómo se calculan mis') + 1 : 0));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('Spanish DWC split revision footer fragments are all masked before packet footer stamping', async () => {
  const bytes = readFileSync(new URL('../statutory/statutory-dwc-time-of-hire-es.pdf', import.meta.url));
  const masks = await locateStatutoryFooterMasks(bytes);
  assert.equal(masks.length, 8);
  for (let page = 0; page < 6; page++) {
    assert.ok(masks[page].some((mask) =>
      mask.x < 160 && mask.x + mask.width > 290 && mask.y < 25),
    `page ${page + 1} leaves the split “Revisado” fragment visible`);
    assert.ok(masks[page].some((mask) =>
      mask.x < 160 && mask.x + mask.width > 450 && mask.y < 40),
    `page ${page + 1} leaves the split “En vigor” fragment visible`);
    assert.ok(masks[page].some((mask) => mask.x + mask.width > 565 && mask.y < 35),
      `page ${page + 1} leaves the source page number visible`);
  }
});

test('combined packet footers use one exact first and last page label', () => {
  for (const total of [82, 87]) {
    const footers = packetFooterDescriptors(total);
    assert.equal(footers.length, total);
    assert.equal(footers[0].number, `Page 1 of ${total}`);
    assert.equal(footers.at(-1).number, `Page ${total} of ${total}`);
    assert.equal(new Set(footers.map((footer) => footer.page)).size, total);
  }
});

test('field matching is attachment-aware and independent of API array order', () => {
  const sources = [
    { order: 0, slug: 'agreement', outputStartPage: 0, pageCount: 2 },
    { order: 1, slug: 'acknowledgment', outputStartPage: 2, pageCount: 2 },
  ];
  const generated = [
    { id: 'f1', name: 'Name', sourceSlug: 'agreement', sourcePage: 0, owner: 'worker', type: 'text', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
    { id: 'f2', name: 'Date', sourceSlug: 'acknowledgment', sourcePage: 1, owner: 'employer', type: 'date', page: 3, x: 0.4, y: 0.5, w: 0.2, h: 0.03 },
  ];
  const live = {
    schema: [
      { name: 'agreement.pdf', attachment_uuid: 'doc-agreement' },
      { name: 'acknowledgment.pdf', attachment_uuid: 'doc-acknowledgment' },
    ],
    submitters: [{ name: 'Worker', uuid: 'sw' }, { name: 'Hamilton', uuid: 'sh' }],
    fields: [
      { uuid: 'u2', type: 'date', submitter_uuid: 'sh', areas: [{ attachment_uuid: 'doc-acknowledgment', page: 1, x: 0.4, y: 0.5, w: 0.2, h: 0.03 }] },
      { uuid: 'u1', type: 'text', submitter_uuid: 'sw', areas: [{ attachment_uuid: 'doc-agreement', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] },
    ],
  };
  const matched = matchGeneratedFields(generated, live, sources);
  assert.equal(matched.get('f1'), 'u1');
  assert.equal(matched.get('f2'), 'u2');
  live.fields[0].areas[0].attachment_uuid = 'doc-agreement';
  assert.throws(() => matchGeneratedFields(generated, live, sources), /no live field matches/);
});

test('global packet pages map to exact source-local boundary pages', () => {
  const sources = [
    { order: 0, slug: 'agreement', outputStartPage: 0, pageCount: 6 },
    { order: 1, slug: 'wage', outputStartPage: 6, pageCount: 5 },
    { order: 2, slug: 'ack', outputStartPage: 11, pageCount: 5 },
  ];
  const fields = [
    { id: 'agreement-last', sourceSlug: 'agreement', page: 5 },
    { id: 'wage-first', sourceSlug: 'wage', page: 6 },
    { id: 'wage-last', sourceSlug: 'wage', page: 10 },
    { id: 'ack-first', sourceSlug: 'ack', page: 11 },
  ];
  const mapped = mapFieldsToSourceAttachments(fields, sources);
  assert.deepEqual(mapped.map(({ sourcePage, attachmentOrder }) => [sourcePage, attachmentOrder]), [
    [5, 0], [0, 1], [4, 1], [0, 2],
  ]);
  assert.deepEqual(
    providerFieldGeometry({ ...mapped[3], x: 0.1, y: 0.2, w: 0.3, h: 0.04 }, 'doc-ack'),
    { attachment_uuid: 'doc-ack', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
  );
  assert.throws(
    () => mapFieldsToSourceAttachments([{ id: 'crossed', sourceSlug: 'agreement', page: 6 }], sources),
    /falls outside agreement/,
  );
});

test('v3 upload plan contains all 15 measured source PDFs in manifest order', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2-source-uploads-'));
  const slug = 'packet-v3';
  const sourceDir = join(root, `${slug}.sources`);
  mkdirSync(sourceDir);
  const sources = Array.from({ length: 15 }, (_, order) => {
    const sourceSlug = `source-${order + 1}`;
    const attachmentFilename = `${sourceSlug}.pdf`;
    const bytes = Buffer.from(`deterministic-pdf-${order + 1}`);
    writeFileSync(join(sourceDir, attachmentFilename), bytes);
    return {
      order,
      slug: sourceSlug,
      outputStartPage: order,
      pageCount: 1,
      attachmentFilename,
      attachmentSha256: bytesSha256(bytes),
    };
  });
  const fields = mapFieldsToSourceAttachments([
    { id: 'first', sourceSlug: 'source-1', page: 0 },
    { id: 'last', sourceSlug: 'source-15', page: 14 },
  ], sources);
  const uploads = orderedSourceUploads({ slug, sources, fields, pageCount: 15 }, root, 15);
  assert.equal(uploads.length, 15);
  assert.deepEqual(uploads.map((upload) => upload.filename), sources.map((source) => source.attachmentFilename));
  assert.deepEqual(uploads.map((upload) => bytesSha256(upload.bytes)), sources.map((source) => source.attachmentSha256));
  const appended = [];
  assert.equal(appendOrderedSourceUploads({
    append: (key, value, filename) => appended.push({ key, value, filename }),
  }, uploads), 15);
  assert.equal(appended.length, 15);
  assert.ok(appended.every((item) => item.key === 'files[]' && item.value.type === 'application/pdf'));
  assert.deepEqual(appended.map((item) => item.filename), uploads.map((upload) => upload.filename));
});

test('provider PDF names canonicalize only an optional final lowercase suffix', () => {
  assert.equal(canonicalProviderPdfName('employment-agreement'), 'employment-agreement');
  assert.equal(canonicalProviderPdfName('employment-agreement.pdf'), 'employment-agreement');
  for (const value of [
    ' employment-agreement.pdf', 'employment-agreement.pdf ', 'folder/employment-agreement.pdf',
    'folder\\employment-agreement.pdf', 'employment-agreement.PDF', 'employment-agreement.pdf.pdf',
    'employment agreement.pdf',
  ]) {
    assert.throws(() => canonicalProviderPdfName(value), /provider PDF name/);
  }
});

test('IIPP administrative phone is plain text while review fields remain dates', () => {
  assert.equal(classify('Administrator phone', ''), 'text');
  assert.equal(classify('Reviewed / updated', ''), 'date');
  assert.equal(classify('Effective date', ''), 'date');
  assert.equal(classify('Program administrator', ''), 'text');
});

test('reflow stamping synchronizes measured field types and classes', () => {
  const source = '<span class="ds" id="f1" data-type="text"></span>' +
    '<span class="ds ds-date" id="f2" data-type="date" data-hx-uuid="stale"></span>';
  const fields = [
    { id: 'f1', type: 'text', presentation: 'phone' },
    { id: 'f2', type: 'date' },
  ];
  const result = stampReflowAnchors(source, fields, new Map([['f1', 'u1'], ['f2', 'u2']]));
  assert.equal(result.stamped, 2);
  assert.match(result.html, /class="ds ds-phone" id="f1" data-hx-uuid="u1" data-type="text" data-presentation="phone"/);
  assert.match(result.html, /class="ds ds-date" id="f2" data-hx-uuid="u2" data-type="date"/);
  assert.doesNotMatch(result.html, /stale/);
  assert.throws(() => stampReflowAnchors(source, fields, new Map([['f1', 'u1']])), /missing live UUID/);
});

test('generated geometry rejects narrow, overlapping, and semantically mistyped fields', () => {
  const valid = {
    pageCount: 1,
    fields: [
      { name: 'Administrator phone', type: 'text', presentation: 'phone', page: 0, x: 0.2, y: 0.2, w: 150 / 816, h: 21 / 1056 },
      { name: 'Reviewed / updated', type: 'date', page: 0, x: 0.5, y: 0.3, w: 130 / 816, h: 21 / 1056 },
    ],
  };
  assert.deepEqual(validateGeneratedGeometry(valid), []);
  const broken = structuredClone(valid);
  broken.fields[0].w = 44 / 816;
  broken.fields[1].type = 'text';
  broken.fields[1].x = broken.fields[0].x;
  broken.fields[1].y = broken.fields[0].y;
  const problems = validateGeneratedGeometry(broken).join('\n');
  assert.match(problems, /too small for phone/);
  assert.match(problems, /semantic type date, got text/);
  assert.match(problems, /overlaps/);
});

function iippMigrationFixture() {
  const submitter = { name: 'Hamilton', uuid: 'role-hamilton' };
  const definitions = [
    ['Effective date', 'date', 0.38163, 0.05392, 0.15931],
    ['Administrator phone', 'phone', 0.45076, 0.05392, 0.18382],
    ['Reviewed / updated', 'text', 0.48674, 0.05392, 0.15931],
    ['Signature', 'signature', 0.16761, 0.30637, 0.30637],
    ['Date', 'date', 0.23011, 0.15931, 0.15931],
  ];
  const fields = definitions.map(([name, type, y, oldWidth]) => ({
    uuid: `uuid-${name}`,
    name,
    type,
    required: true,
    submitter_uuid: submitter.uuid,
    areas: [{ page: name === 'Signature' || name === 'Date' ? 5 : 0, x: 0.25, y, w: oldWidth, h: name === 'Signature' ? 0.0322 : 0.01989, attachment_uuid: 'old-attachment' }],
  }));
  const generated = {
    slug: 'iipp',
    fields: definitions.map(([name, type, y, _oldWidth, targetWidth]) => ({
      id: `id-${name}`,
      name,
      type: name === 'Reviewed / updated' ? 'date' : name === 'Administrator phone' ? 'text' : type,
      ...(name === 'Administrator phone' ? { presentation: 'phone' } : {}),
      owner: 'employer',
      page: name === 'Signature' || name === 'Date' ? 5 : 0,
      x: 0.25,
      y,
      w: targetWidth,
      h: name === 'Signature' ? 0.0322 : 0.01989,
    })),
  };
  const template = {
    id: 360,
    name: 'Injury and Illness Prevention Program (IIPP)',
    schema: [{ name: 'iipp.pdf', attachment_uuid: 'old-attachment' }],
    submitters: [submitter],
    fields,
  };
  return { template, generated };
}

test('IIPP migration preserves identity and UUIDs while changing only guarded fields', () => {
  const { template, generated } = iippMigrationFixture();
  const plan = planIippMigration(template, generated);
  assert.equal(plan.alreadyApplied, false);
  assert.ok(plan.changes.some((change) => /Administrator phone: type phone -> text/.test(change)));
  assert.ok(plan.changes.some((change) => /Reviewed \/ updated: type text -> date/.test(change)));
  const fields = buildMigratedFields(template, generated, 'new-attachment');
  assert.deepEqual(fields.map((field) => field.uuid), template.fields.map((field) => field.uuid));
  assert.ok(fields.every((field) => field.areas[0].attachment_uuid === 'new-attachment'));
  const after = { ...template, schema: [{ name: 'iipp.pdf', attachment_uuid: 'new-attachment' }], fields };
  assert.doesNotThrow(() => assertIippPostflight(template, after, generated, 'new-attachment'));
  const partiallyApplied = iippMigrationFixture();
  partiallyApplied.template.fields.find((field) => field.name === 'Reviewed / updated').type = 'date';
  const partialPlan = planIippMigration(partiallyApplied.template, partiallyApplied.generated);
  assert.deepEqual(partialPlan.changes.filter((change) => change.includes('type')), [
    'Administrator phone: type phone -> text',
  ]);
  partiallyApplied.template.fields.find((field) => field.name === 'Reviewed / updated').type = 'phone';
  assert.throws(
    () => planIippMigration(partiallyApplied.template, partiallyApplied.generated),
    /outside the guarded baseline or generated target/,
  );
  const changed = structuredClone(template);
  changed.fields.find((field) => field.name === 'Signature').areas[0].x += 0.01;
  assert.throws(() => planIippMigration(changed, generated), /Signature generated geometry changed unexpectedly/);
});

test('worker type is mandatory and packets never fall across classifications', () => {
  assert.throws(() => packetFor(undefined, 'en'), /worker type is required/);
  assert.deepEqual(packetFor('overseas_contractor', 'en').docs.map((doc) => doc.title),
    ['Independent Contractor Agreement']);
  assert.ok(packetFor('w2_local', 'en').docs.some((doc) => doc.title === 'W-2 Initial Employment Packet v3'));
  const wrong = validate({ type: 'overseas_contractor', name: 'ZZ TEST', phone: '+16509773241' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems.join(' '), /looks domestic/);
});

test('CSS scoping catches selectors after comments and rejects a bare selector', () => {
  const scoped = scopeCss('/* comment */ .ds{color:red} body{margin:0}', '#hx-read-doc');
  assert.match(scoped, /#hx-read-doc \.ds/);
  assert.doesNotThrow(() => assertScoped(scoped, '#hx-read-doc'));
  assert.throws(() => assertScoped('.ds{color:red}', '#hx-read-doc'), /not fully scoped/);
});

test('reflow tables expose real column headers and replace empty headers with row headers', () => {
  const headed = normalizeReflowTables('<table><thead><tr><th>Name</th><th class="n">Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>');
  assert.match(headed, /<th scope="col">Name<\/th>/);
  assert.match(headed, /<th scope="col" class="n">Value<\/th>/);

  const partial = normalizeReflowTables('<table><thead><tr><th></th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>');
  assert.match(partial, /<td aria-hidden="true"><\/td>/);
  assert.doesNotMatch(partial, /<th[^>]*>\s*<\/th>/);
  assert.match(partial, /<th scope="col">Value<\/th>/);

  const empty = normalizeReflowTables('<table><thead><tr><th></th><th>&nbsp;</th></tr></thead><tbody><tr><td><span id="f1"></span> Task</td><td>Done</td></tr></tbody></table>');
  assert.doesNotMatch(empty, /<thead/);
  assert.match(empty, /<th scope="row"><span id="f1"><\/span> Task<\/th>/);
  assert.match(empty, /<td>Done<\/td>/);
  assert.equal((empty.match(/id="f1"/g) || []).length, 1);
});

test('Code of Safe Practices scopes its Spanish section without changing other documents', () => {
  const html = '<h1>ENGLISH</h1><p>Safe</p><h1>ESPAÑOL</h1><p>Seguro</p>';
  assert.equal(
    scopeDocumentLanguages(html, 'code-of-safe-practices'),
    '<h1>ENGLISH</h1><p>Safe</p><h1 lang="es">ESPAÑOL</h1><p lang="es">Seguro</p>',
  );
  assert.equal(scopeDocumentLanguages(html, 'iipp'), html);
  assert.throws(
    () => scopeDocumentLanguages('<h1>ENGLISH</h1>', 'code-of-safe-practices'),
    /missing its ESPAÑOL section/,
  );
});
