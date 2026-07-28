import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocusealClient } from '../pipeline/docuseal-api.mjs';
import { requireUniqueActiveTemplate, DEFAULT_DOCUMENT_SLUGS } from '../pipeline/registry.mjs';
import { matchGeneratedFields } from '../pipeline/field-match.mjs';
import { packetFor, validate } from '../pipeline/worker-types.mjs';
import { scopeCss, assertScoped } from '../pipeline/build-docs.mjs';

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
