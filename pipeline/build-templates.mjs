// Create DocuSeal templates from the measured PDFs + field coordinates.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BUILD_DIR, loadDocusealSecrets } from './config.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { TEMPLATE_BY_SLUG } from './registry.mjs';

const DIR = BUILD_DIR;
const SEC = loadDocusealSecrets();
const client = createDocusealClient(SEC);
const URL_ = SEC.url;

// Per-hire docs are signed by the worker; company programs are signed once by the employer.
const COMPANY = new Set(['iipp', 'heat-illness-prevention-plan', 'heat-illness-prevention-plan-es',
  'fall-protection-program', 'code-of-safe-practices']);
// The title is the signer's page heading and browser tab, so it must match the
// heading printed on the document itself — a worker should not be told he is
// opening one thing and then shown another. Accents are part of the name;
// stripping them to stay ASCII is not a simplification, it is a misspelling.
const TITLES = Object.fromEntries([...TEMPLATE_BY_SLUG].map(([slug, entry]) => [slug, entry.title]));

// Sections and fields that only apply to some workers. Forcing these produces a
// signed record asserting something untrue: a roofer who does not supervise
// cannot honestly initial supervisor training, and a worker who answers NO to
// driving cannot honestly attest he holds a licence and authorizes an MVR pull.
const CONDITIONAL_SECTION = /supervisor|capataz|foreman|driving|manejo de veh/i;
const CONDITIONAL_FIELD = /if assigned|si se asigna|if driving|si maneja|respirator|respirador|Section H|secci[óo]n H/i;

// --- session (admin UI endpoints) -------------------------------------------
let cookie = '';
const setCookie = (r) => {
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map(s => s.split(';')[0]).join('; ');
};
const tokenFrom = (html, actionRe) => {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map(m => m[0]);
  const f = forms.find(x => actionRe.test(x)) || forms[0];
  return (f.match(/name="authenticity_token"[^>]*value="([^"]*)"/) || [])[1];
};

async function signIn() {
  let r = await fetch(`${URL_}/sign_in`); setCookie(r);
  if (!r.ok) throw new Error(`sign_in page failed ${r.status}`);
  const html = await r.text();
  const tok = tokenFrom(html, /sign_in/);
  if (!tok) throw new Error('sign_in page returned no authenticity token');
  const body = new URLSearchParams({ authenticity_token: tok, 'user[email]': SEC.email, 'user[password]': SEC.password });
  r = await fetch(`${URL_}/sign_in`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  setCookie(r);
  if (r.status !== 303 && r.status !== 302) throw new Error('sign_in failed ' + r.status);
}

async function createTemplate(name) {
  let r = await fetch(`${URL_}/templates/new`, { headers: { cookie } }); setCookie(r);
  if (!r.ok) throw new Error(`new template page failed ${r.status}`);
  const tok = tokenFrom(await r.text(), /action="\/templates"/);
  if (!tok) throw new Error('new template page returned no authenticity token');
  const body = new URLSearchParams({ authenticity_token: tok, 'template[name]': name });
  r = await fetch(`${URL_}/templates`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  setCookie(r);
  const loc = r.headers.get('location') || '';
  const id = (loc.match(/\/templates\/(\d+)/) || [])[1];
  if (!id) throw new Error('no template id from ' + loc + ' status ' + r.status);
  return id;
}

async function uploadPdf(id, slug) {
  const r0 = await fetch(`${URL_}/templates/${id}/edit`, { headers: { cookie } }); setCookie(r0);
  if (!r0.ok) throw new Error(`template ${id} edit page failed ${r0.status}`);
  const csrf = ((await r0.text()).match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error(`template ${id} edit page returned no CSRF token`);
  const fd = new FormData();
  fd.append('files[]', new Blob([readFileSync(`${DIR}/${slug}.pdf`)], { type: 'application/pdf' }), `${slug}.pdf`);
  const r = await fetch(`${URL_}/templates/${id}/documents`, {
    method: 'POST', headers: { cookie, 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: fd });
  setCookie(r);
  const text = await r.text();
  if (!r.ok) throw new Error(`upload ${slug} failed ${r.status}: ${text.slice(0, 160)}`);
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`upload ${slug} returned non-JSON content`); }
  if (!j.schema) throw new Error('upload failed: ' + JSON.stringify(j).slice(0, 200));
  return { schema: j.schema, csrf };
}

async function saveTemplate(id, schema, csrf, submitters, fields) {
  const r = await fetch(`${URL_}/templates/${id}`, {
    method: 'PUT', headers: { cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ schema, submitters, fields }) });
  setCookie(r);
  const body = (await r.text()).slice(0, 200);
  if (!r.ok) throw new Error(`save template ${id} failed ${r.status}${body ? `: ${body}` : ''}`);
  return r.status;
}

/** Template preferences via POST /templates/:id/preferences — the permitted
 *  route for this (the admin PUT rejects a preferences key with 422, and the
 *  REST API silently drops it).
 *
 *  - submitters_order=preserved: page-level signing-order enforcement. Without
 *    it the countersigner URL renders a live, signable form before the worker
 *    has signed. The delivery-side withholding in send-signing-link.mjs stays
 *    as the second layer.
 *  - completed_message: the completion screen otherwise promises nothing — the
 *    worker's signed copy arrives later by WhatsApp and the on-screen download
 *    quietly dies 30 minutes after signing, so the screen must say what
 *    actually happens next, in the signer's language. */
async function savePreferences(id, csrf, es, twoParty) {
  const msg = twoParty
    ? (es
      ? { title: 'Listo, firmado', body: 'Alex firma después y te mandamos tu copia firmada aquí mismo por WhatsApp. No necesitas descargar nada.' }
      : { title: 'Done, signed', body: 'Alex signs next, then your signed copy comes right back to you on WhatsApp. You do not need to download anything.' })
    : (es
      ? { title: 'Firmado y archivado', body: 'Este documento queda archivado en los registros de Hamilton.' }
      : { title: 'Signed and filed', body: 'This document is filed in Hamilton\'s records.' });
  const body = new URLSearchParams({
    'template[preferences][submitters_order]': 'preserved',
    'template[preferences][completed_message][title]': msg.title,
    'template[preferences][completed_message][body]': msg.body,
  });
  const r = await fetch(`${URL_}/templates/${id}/preferences`, {
    method: 'POST',
    headers: { cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  setCookie(r);
  const responseBody = (await r.text()).slice(0, 200);
  if (!r.ok) throw new Error(`save preferences for ${id} failed ${r.status}${responseBody ? `: ${responseBody}` : ''}`);
  return r.status;
}

// --- main --------------------------------------------------------------------
const docs = JSON.parse(readFileSync(`${DIR}/fields.json`, 'utf8'));
const inventory = await client.listAll('/api/templates', { what: 'template inventory' });
for (const document of docs) {
  const entry = TEMPLATE_BY_SLUG.get(document.slug);
  if (!entry) throw new Error(`no registered template for ${document.slug}`);
  if (document.fields.length !== entry.fields) {
    throw new Error(`${document.slug} expected ${entry.fields} fields, build has ${document.fields.length}`);
  }
  const collisions = inventory.filter((template) => template.name === entry.title && !template.archived_at);
  if (collisions.length) {
    throw new Error(`refusing to create duplicate active template "${entry.title}"; found ${collisions.length}`);
  }
}
await signIn();
console.log('signed in\n');
const built = [];
for (const d of docs) {
  const name = TITLES[d.slug] || d.slug;
  const id = await createTemplate(name);
  const { schema, csrf } = await uploadPdf(id, d.slug);
  const au = schema[0].attachment_uuid;

  // Two-party where the document actually has two parties. The worker signs
  // first; Hamilton countersigns. Never let one role own both blocks.
  const owners = [...new Set(d.fields.map(f => f.owner))];
  const subs = {};
  if (owners.includes('worker')) subs.worker = { name: 'Worker', uuid: randomUUID() };
  if (owners.includes('employer')) subs.employer = { name: 'Hamilton', uuid: randomUUID() };
  const submitters = [subs.worker, subs.employer].filter(Boolean);

  // `name` renders in `field-area-active-label`: absolutely positioned, no
  // truncate, no max-width, inside a page-container that clips overflow. Only
  // ~50 chars survive. Putting the section in `name` was therefore worse than
  // nothing — the surviving 50 chars were the INVARIANT prefix, identical for
  // 8-13 consecutive fields, and the varying topic was the part clipped off.
  //
  // So: `name` stays short and carries only what changes. Position goes first
  // because it is 5 chars and always visible. Section orientation moves to
  // `description`, which DocuSeal renders in its own element below the label.
  const perOwner = {};
  for (const f of d.fields) perOwner[f.owner] = (perOwner[f.owner] || 0) + 1;
  const idx = {};
  const NAME_MAX = 46;

  const seen = new Map();
  const fields = d.fields.map((f) => {
    idx[f.owner] = (idx[f.owner] || 0) + 1;
    const total = perOwner[f.owner];
    // Only worth showing on documents long enough to feel long.
    const pos = total >= 8 ? `${idx[f.owner]}/${total} ` : '';
    let short = f.name;
    if (short.length > NAME_MAX) {
      const cut = short.slice(0, NAME_MAX);
      const sp = cut.lastIndexOf(' ');
      short = (sp > NAME_MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s(,;:-]+$/, '') + '…';
    }
    let nm = `${pos}${short}`;
    const n = (seen.get(nm) || 0) + 1; seen.set(nm, n);
    if (n > 1) nm = `${nm} (${n})`;
    // Most blanks are mandatory: a signer must not skip an acknowledgment line
    // and still produce a "signed" record. But `required: true` on a field
    // inside a CONDITIONAL section forces a false attestation — the supervisor
    // part says "complete only if the employee supervises", the driving section
    // only applies if he answers YES, and several roster rows say "if assigned".
    // Forcing those manufactures exactly the false record the pamphlet guard
    // exists to prevent, so conditional sections are optional.
    // A checkbox is one option out of a mutually exclusive set — exactly one of
    // Roofer/Foreman is ticked, one language, one sick-leave method. Marking
    // them required would demand Hamilton tick BOTH Roofer and Foreman.
    const conditional = f.type === 'checkbox' ||
      CONDITIONAL_SECTION.test(f.section || '') ||
      CONDITIONAL_FIELD.test(f.name || '');
    return { uuid: randomUUID(), submitter_uuid: (subs[f.owner] || submitters[0]).uuid,
      name: nm, type: f.type, required: !conditional,
      ...(f.section ? { description: f.section } : {}),
      areas: [{ x: f.x, y: f.y, w: f.w, h: f.h, attachment_uuid: au, page: f.page }] };
  });
  const st = await saveTemplate(id, schema, csrf, submitters, fields);
  const es = /-es$/.test(d.slug);
  const twoParty = submitters.length > 1;
  const pst = await savePreferences(id, csrf, es, twoParty);
  const saved = await client.request(`/api/templates/${id}`, {}, `saved template ${id}`);
  if (saved.name !== name || (saved.fields || []).length !== fields.length) {
    throw new Error(`saved template ${id} failed read-back verification`);
  }
  const savedRoles = (saved.submitters || []).map((submitter) => submitter.name).sort();
  const expectedRoles = submitters.map((submitter) => submitter.name).sort();
  if (JSON.stringify(savedRoles) !== JSON.stringify(expectedRoles)) {
    throw new Error(`saved template ${id} roles are ${savedRoles.join(', ')}, expected ${expectedRoles.join(', ')}`);
  }
  const split = owners.map(o => `${o}:${d.fields.filter(f => f.owner === o).length}`).join(' ');
  console.log(`${String(id).padStart(3)}  ${name.padEnd(44)} ${String(fields.length).padStart(3)}f  [${split}]  save=${st} prefs=${pst}`);
  // Map each field marker in the source HTML to the uuid just minted for it.
  // `fields` is a 1:1 map over `d.fields`, so index i is the same field in both,
  // and d.fields[i].id is the span id build-docs wrote ("f7"). Keying on that id
  // rather than on document order means a reordered document cannot quietly
  // attach a field to the wrong blank on a signed record.
  const uuidById = Object.fromEntries(d.fields.map((f, i) => [f.id, fields[i].uuid]));
  built.push({ id, slug: d.slug, name, roles: submitters.map(s => s.name), fields: fields.length, uuidById });
}
console.log('\nbuilt ' + built.length + ' templates');

// Stage the mobile reading views into the repo so the image is self-contained.
//
// Keyed by the live template NAME, because that is the only identifier the
// signer page exposes: pages are anchored as page-<attachment_uuid>-<n> and the
// source filename never reaches the browser. This is the one place that knows
// both the slug and the template name, so the index is written here.
const REFLOW_DIR = new URL('../brand/reflow/', import.meta.url);
mkdirSync(REFLOW_DIR, { recursive: true });
const index = {};
for (const b of built) {
  const src = `${DIR}/${b.slug}.reflow.html`;
  if (!existsSync(src)) { console.log(`  no reading view for ${b.slug}, skipped`); continue; }
  // Stamp the uuids in, so Vue can teleport the real field into the right blank.
  let html = readFileSync(src, 'utf8');
  let stamped = 0;
  for (const [fid, uuid] of Object.entries(b.uuidById || {})) {
    const before = html;
    html = html.replace(`id="${fid}"`, `id="${fid}" data-hx-uuid="${uuid}"`);
    if (html !== before) stamped++;
  }
  const markers = (html.match(/class="ds[^"]*"/g) || []).length;
  if (stamped !== markers) {
    throw new Error(`${b.slug}: stamped ${stamped} field anchor(s) but the reading ` +
      `view has ${markers} marker(s). A blank with no uuid silently becomes unfillable ` +
      'in the reflowed view, so this is a hard stop rather than a warning.');
  }
  writeFileSync(new URL(`${b.slug}.reflow.html`, REFLOW_DIR), html);
  index[b.name] = b.slug;
}
writeFileSync(new URL('index.json', REFLOW_DIR), JSON.stringify(index, null, 2) + '\n');
console.log(`staged ${Object.keys(index).length} reading view(s) into brand/reflow/`);
