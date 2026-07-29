import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocusealClient } from '../pipeline/docuseal-api.mjs';
import { requireUniqueActiveTemplate, DEFAULT_DOCUMENT_SLUGS } from '../pipeline/registry.mjs';
import { matchGeneratedFields } from '../pipeline/field-match.mjs';
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

test('template resolution fails on zero or duplicate active names', () => {
  const template = { id: 1, name: 'Employment Agreement', archived_at: null };
  assert.equal(requireUniqueActiveTemplate([template], template.name), template);
  assert.throws(() => requireUniqueActiveTemplate([], template.name), /found 0/);
  assert.throws(() => requireUniqueActiveTemplate([template, { ...template, id: 2 }], template.name), /found 2/);
  assert.ok(DEFAULT_DOCUMENT_SLUGS.includes('independent-contractor-agreement'));
  assert.equal(DEFAULT_DOCUMENT_SLUGS.length, 14);
});

test('field matching is independent of API array order', () => {
  const generated = [
    { id: 'f1', name: 'Name', owner: 'worker', type: 'text', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
    { id: 'f2', name: 'Date', owner: 'employer', type: 'date', page: 1, x: 0.4, y: 0.5, w: 0.2, h: 0.03 },
  ];
  const live = {
    submitters: [{ name: 'Worker', uuid: 'sw' }, { name: 'Hamilton', uuid: 'sh' }],
    fields: [
      { uuid: 'u2', type: 'date', submitter_uuid: 'sh', areas: [{ page: 1, x: 0.4, y: 0.5, w: 0.2, h: 0.03 }] },
      { uuid: 'u1', type: 'text', submitter_uuid: 'sw', areas: [{ page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] },
    ],
  };
  const matched = matchGeneratedFields(generated, live);
  assert.equal(matched.get('f1'), 'u1');
  assert.equal(matched.get('f2'), 'u2');
  live.fields[0].areas[0].x = 0.41;
  assert.throws(() => matchGeneratedFields(generated, live), /no live field matches/);
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
  assert.ok(packetFor('w2_local', 'en').docs.some((doc) => doc.title === 'Employment Agreement'));
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
