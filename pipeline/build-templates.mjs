// Create DocuSeal templates from the measured PDFs + field coordinates.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DIR = 'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/build';
const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));
const URL_ = SEC.url;

// Per-hire docs are signed by the worker; company programs are signed once by the employer.
const COMPANY = new Set(['iipp', 'heat-illness-prevention-plan', 'heat-illness-prevention-plan-es',
  'fall-protection-program', 'code-of-safe-practices']);
// The title is the signer's page heading and browser tab, so it must match the
// heading printed on the document itself — a worker should not be told he is
// opening one thing and then shown another. Accents are part of the name;
// stripping them to stay ASCII is not a simplification, it is a misspelling.
const TITLES = {
  'employment-agreement': 'Employment Agreement',
  'employment-agreement-es': 'Contrato de Empleo',
  'wage-notice-2810-5': 'Wage Notice - Labor Code 2810.5',
  'wage-notice-2810-5-es': 'Aviso de Salario - Código Laboral 2810.5',
  'policy-acknowledgment': 'New Hire Policy Acknowledgment',
  'policy-acknowledgment-es': 'Acuse de Recibo de Políticas',
  'safety-training-roster': 'Safety Training Roster',
  'safety-training-roster-es': 'Registro de Capacitación en Seguridad',
  'iipp': 'Injury and Illness Prevention Program (IIPP)',
  'heat-illness-prevention-plan': 'Heat Illness Prevention Plan',
  'heat-illness-prevention-plan-es': 'Plan de Prevención de Enfermedades por Calor',
  'fall-protection-program': 'Fall Protection Program',
  'code-of-safe-practices': 'Code of Safe Practices',
};

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
  const html = await r.text();
  const tok = tokenFrom(html, /sign_in/);
  const body = new URLSearchParams({ authenticity_token: tok, 'user[email]': SEC.email, 'user[password]': SEC.password });
  r = await fetch(`${URL_}/sign_in`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  setCookie(r);
  if (r.status !== 303 && r.status !== 302) throw new Error('sign_in failed ' + r.status);
}

async function createTemplate(name) {
  let r = await fetch(`${URL_}/templates/new`, { headers: { cookie } }); setCookie(r);
  const tok = tokenFrom(await r.text(), /action="\/templates"/);
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
  const csrf = ((await r0.text()).match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  const fd = new FormData();
  fd.append('files[]', new Blob([readFileSync(`${DIR}/${slug}.pdf`)], { type: 'application/pdf' }), `${slug}.pdf`);
  const r = await fetch(`${URL_}/templates/${id}/documents`, {
    method: 'POST', headers: { cookie, 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: fd });
  setCookie(r);
  const j = await r.json();
  if (!j.schema) throw new Error('upload failed: ' + JSON.stringify(j).slice(0, 200));
  return { schema: j.schema, csrf };
}

async function saveTemplate(id, schema, csrf, submitters, fields) {
  const r = await fetch(`${URL_}/templates/${id}`, {
    method: 'PUT', headers: { cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ schema, submitters, fields }) });
  setCookie(r);
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
      ? { title: 'Listo — firmado', body: 'Alex firma después y te mandamos tu copia firmada aquí mismo por WhatsApp. No necesitas descargar nada.' }
      : { title: 'Done — signed', body: 'Alex signs next, then your signed copy comes right back to you on WhatsApp. You do not need to download anything.' })
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
  return r.status;
}

// --- main --------------------------------------------------------------------
const docs = JSON.parse(readFileSync(`${DIR}/fields.json`, 'utf8'));
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

  // The drawer prompt is the only text a signer reads at each step, so it
  // carries position and section: "3/31 · A · Documents I received — DE 2320…".
  // Without this a 58-field roster is an undifferentiated grind with no sense
  // of progress, which the critique identified as the abandonment point.
  const perOwner = {};
  for (const f of d.fields) perOwner[f.owner] = (perOwner[f.owner] || 0) + 1;
  const idx = {};

  const seen = new Map();
  const fields = d.fields.map((f) => {
    idx[f.owner] = (idx[f.owner] || 0) + 1;
    const total = perOwner[f.owner];
    // Only worth showing on documents long enough to feel long.
    const pos = total >= 8 ? `${idx[f.owner]}/${total} · ` : '';
    const sec = f.section ? `${f.section} — ` : '';
    let nm = `${pos}${sec}${f.name}`;
    const n = (seen.get(nm) || 0) + 1; seen.set(nm, n);
    if (n > 1) nm = `${nm} (${n})`;
    // Compliance documents: every blank is mandatory. A signer must not be able
    // to skip an acknowledgment line and still produce a "signed" record.
    return { uuid: randomUUID(), submitter_uuid: (subs[f.owner] || submitters[0]).uuid,
      name: nm, type: f.type, required: true,
      areas: [{ x: f.x, y: f.y, w: f.w, h: f.h, attachment_uuid: au, page: f.page }] };
  });
  const st = await saveTemplate(id, schema, csrf, submitters, fields);
  const es = /-es$/.test(d.slug);
  const twoParty = submitters.length > 1;
  const pst = await savePreferences(id, csrf, es, twoParty);
  const split = owners.map(o => `${o}:${d.fields.filter(f => f.owner === o).length}`).join(' ');
  console.log(`${String(id).padStart(3)}  ${name.padEnd(44)} ${String(fields.length).padStart(3)}f  [${split}]  save=${st} prefs=${pst}`);
  built.push({ id, slug: d.slug, name, roles: submitters.map(s => s.name), fields: fields.length });
}
console.log('\nbuilt ' + built.length + ' templates');
