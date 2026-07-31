// Create DocuSeal templates from the measured PDFs + field coordinates.
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { BUILD_DIR, DOCS_DIR, loadDocusealSecrets } from './config.mjs';
import { sha256, validateMeasuredBuild } from './build-manifest.mjs';
import { fingerprintPdf } from './pdf-fingerprint.mjs';
import { buildProviderAttestation } from './provider-attestation.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { TEMPLATE_BY_SLUG } from './registry.mjs';
import { stampReflowAnchors } from './reflow-anchor.mjs';
import {
  appendOrderedSourceUploads,
  canonicalProviderPdfName,
  orderedSourceUploads,
  providerFieldGeometry,
} from './packet-topology.mjs';
import {
  createTemplateCreationJournal,
  createTemplateCreationProcessLock,
  pollUncertainCreation,
  recoverPendingCreationBatch,
  stageCreationArtifacts,
} from './template-creation-recovery.mjs';
import { verifyCreatedTemplateReadback } from './template-mutation-safety.mjs';

const DIR = BUILD_DIR;
let SEC;
let client;
let URL_;

// Per-hire docs are signed by the worker; company programs are signed once by the employer.
const COMPANY = new Set(['iipp', 'iipp-es', 'heat-illness-prevention-plan', 'heat-illness-prevention-plan-es',
  'fall-protection-program', 'fall-protection-program-es', 'code-of-safe-practices']);
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

async function createTemplate(name, { journal, knownTemplateIds }) {
  let r = await fetch(`${URL_}/templates/new`, { headers: { cookie } }); setCookie(r);
  if (!r.ok) throw new Error(`new template page failed ${r.status}`);
  const tok = tokenFrom(await r.text(), /action="\/templates"/);
  if (!tok) throw new Error('new template page returned no authenticity token');
  const body = new URLSearchParams({ authenticity_token: tok, 'template[name]': name });
  // Persist the ambiguity marker immediately before the only request that can create
  // remote state. A hard crash after POST can then be reconciled on the next run.
  const attempt = journal.beginAttempt({ name, knownTemplateIds });
  let responseError;
  try {
    r = await fetch(`${URL_}/templates`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
    setCookie(r);
    const loc = r.headers.get('location') || '';
    const id = (loc.match(/\/templates\/(\d+)/) || [])[1];
    if (id && !attempt.knownTemplateIds.includes(String(id))) {
      journal.recordCreated(id, name);
      return id;
    }
    responseError = new Error(`template POST returned no trustworthy new id (status ${r.status}, location ${loc || 'none'})`);
  } catch (error) {
    responseError = error;
  }

  const candidates = await pollUncertainCreation({
    attempt,
    listInventory: () => client.listAll('/api/templates', { what: `uncertain creation ${name}` }),
  });
  if (candidates.length === 1) {
    const id = String(candidates[0].id);
    journal.recordCreated(id, name);
    return id;
  }
  if (candidates.length > 1) {
    throw new Error(`ambiguous template creation produced ${candidates.length} templates; batch recovery must archive every candidate`);
  }
  throw new Error(`${responseError.message}; no candidate became visible and ambiguity journal is retained at ${journal.path}`);
}

async function uploadPdfs(id, document) {
  const r0 = await fetch(`${URL_}/templates/${id}/edit`, { headers: { cookie } }); setCookie(r0);
  if (!r0.ok) throw new Error(`template ${id} edit page failed ${r0.status}`);
  const csrf = ((await r0.text()).match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error(`template ${id} edit page returned no CSRF token`);
  const fd = new FormData();
  appendOrderedSourceUploads(fd, orderedSourceUploads(document, DIR, 15));
  const r = await fetch(`${URL_}/templates/${id}/documents`, {
    method: 'POST', headers: { cookie, 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: fd });
  setCookie(r);
  const text = await r.text();
  if (!r.ok) throw new Error(`upload ${document.slug} failed ${r.status}: ${text.slice(0, 160)}`);
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`upload ${document.slug} returned non-JSON content`); }
  if (!Array.isArray(j.schema) || j.schema.length !== document.sources.length) {
    throw new Error(`${document.slug}: upload returned ${j.schema?.length ?? 'no'} schema documents, expected ${document.sources.length}`);
  }
  const attachmentUuids = new Set();
  j.schema.forEach((schemaDocument, index) => {
    const source = document.sources[index];
    if (!schemaDocument?.attachment_uuid || attachmentUuids.has(schemaDocument.attachment_uuid)) {
      throw new Error(`${document.slug}: upload schema attachment UUIDs are missing or duplicated`);
    }
    attachmentUuids.add(schemaDocument.attachment_uuid);
    if (canonicalProviderPdfName(schemaDocument.name) !== canonicalProviderPdfName(source.attachmentFilename)) {
      throw new Error(`${document.slug}: uploaded document ${index} is ${schemaDocument.name}, expected ${source.attachmentFilename}`);
    }
  });
  return { schema: j.schema, csrf };
}

async function providerDocumentInspections(saved) {
  if (!Array.isArray(saved?.documents)) throw new Error('created template readback omitted documents');
  const inspections = new Map();
  for (const document of saved.documents) {
    if (!document?.uuid || !document?.url || inspections.has(document.uuid)) {
      throw new Error('created template document identity or source URL is missing/duplicated');
    }
    const response = await fetch(document.url);
    if (!response.ok) throw new Error(`created template document ${document.uuid} returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    inspections.set(document.uuid, {
      rawSha256: sha256(bytes),
      sourceByteLength: bytes.byteLength,
      fingerprint: await fingerprintPdf(bytes),
    });
  }
  return inspections;
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
const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (args.some((arg) => arg !== '--apply')) throw new Error('usage: node pipeline/build-templates.mjs [--apply]');
const generated = JSON.parse(readFileSync(`${DIR}/fields.json`, 'utf8'));
const docs = generated.filter((document) => TEMPLATE_BY_SLUG.get(document.slug)?.version === 3);
if (docs.length !== 2 || !docs.some((document) => document.slug === 'w2-initial-packet-v3') ||
  !docs.some((document) => document.slug === 'w2-initial-packet-es-v3')) {
  throw new Error('build-templates requires exactly the two versioned W-2 v3 source-attachment artifacts');
}
for (const document of docs) {
  const entry = TEMPLATE_BY_SLUG.get(document.slug);
  const pdfBytes = readFileSync(`${DIR}/${document.slug}.pdf`);
  validateMeasuredBuild(document, entry, DOCS_DIR, DIR, pdfBytes);
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  if (pdf.getPageCount() !== document.pageCount) {
    throw new Error(`${document.slug}: parsed PDF page count does not match measured output`);
  }
}
if (!apply) {
  for (const document of docs) console.log(`ready ${document.slug} ${document.layoutSha256}`);
  console.log('dry run only; rerun with --apply for explicit transactional creation');
  process.exit(0);
}
const processLock = createTemplateCreationProcessLock();
const lockAcquisition = processLock.acquire();
try {
SEC = loadDocusealSecrets();
client = createDocusealClient(SEC);
URL_ = SEC.url;
const REFLOW_DIR = new URL('../brand/reflow/', import.meta.url);
mkdirSync(REFLOW_DIR, { recursive: true });
const indexPath = new URL('index.json', REFLOW_DIR);
const attestationPath = new URL('provider-attestations.json', REFLOW_DIR);
const artifactPaths = [
  ...docs.map((document) => fileURLToPath(new URL(`${document.slug}.reflow.html`, REFLOW_DIR))),
  fileURLToPath(indexPath),
  fileURLToPath(attestationPath),
];
const creationJournal = createTemplateCreationJournal(undefined, {
  lockOwner: lockAcquisition.metadata,
  reclaimedOwner: lockAcquisition.reclaimed ? lockAcquisition.previous : null,
});
const recovered = await recoverPendingCreationBatch({
  journal: creationJournal,
  listInventory: () => client.listAll('/api/templates', { what: 'pending template creation recovery' }),
  cleanupTemplate: (id) => client.request(
    `/api/templates/${id}`,
    { method: 'DELETE' },
    `archive interrupted template ${id}`,
  ),
});
let inventory = await client.listAll(
  '/api/templates',
  { what: recovered.cleaned.length ? 'template inventory after recovery' : 'template inventory' },
);
if (recovered.cleaned.length) {
  console.log(`cleaned ${recovered.cleaned.length} template(s) from an interrupted creation transaction`);
}
for (const document of docs) {
  const entry = TEMPLATE_BY_SLUG.get(document.slug);
  const collisions = inventory.filter((template) => template.name === entry.title && !template.archived_at);
  if (collisions.length) {
    throw new Error(`refusing to create duplicate active template "${entry.title}"; found ${collisions.length}`);
  }
}
await signIn();
console.log('signed in\n');
creationJournal.beginBatch({
  artifactPaths,
  templates: docs.map((document) => ({ slug: document.slug, name: TITLES[document.slug] || document.slug })),
});
const built = [];
const knownTemplateIds = new Set(inventory.map((template) => String(template.id)));
try {
for (const d of docs) {
  const name = TITLES[d.slug] || d.slug;
  const id = await createTemplate(name, { journal: creationJournal, knownTemplateIds });
  knownTemplateIds.add(String(id));
  const { schema, csrf } = await uploadPdfs(id, d);
  const attachmentUuidByOrder = schema.map((source) => source.attachment_uuid);

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
      areas: [providerFieldGeometry(f, attachmentUuidByOrder[f.attachmentOrder])] };
  });
  const st = await saveTemplate(id, schema, csrf, submitters, fields);
  const es = /(?:^|-)es(?:-|$)/.test(d.slug);
  const twoParty = submitters.length > 1;
  const pst = await savePreferences(id, csrf, es, twoParty);
  const saved = await client.request(`/api/templates/${id}`, {}, `saved template ${id}`);
  const expectedDocuments = d.sources.map((source, index) => ({
    uuid: schema[index].attachment_uuid,
    filename: source.attachmentFilename,
    sha256: source.attachmentSha256,
    fingerprint: source.attachmentFingerprint,
  }));
  const savedDocumentInspections = await providerDocumentInspections(saved);
  const providerMeasuredFields = d.fields.map((field) => ({ ...field, page: field.sourcePage }));
  const uuidById = verifyCreatedTemplateReadback({
    saved,
    expectedId: id,
    expectedName: name,
    expectedSchema: schema,
    expectedDocuments,
    savedDocumentInspections,
    expectedSubmitters: submitters,
    expectedFields: fields,
    measuredFields: providerMeasuredFields,
    ownerUuidByOwner: Object.fromEntries(Object.entries(subs).map(([owner, submitter]) => [owner, submitter.uuid])),
  });
  creationJournal.recordReadback(id);
  const split = owners.map(o => `${o}:${d.fields.filter(f => f.owner === o).length}`).join(' ');
  console.log(`${String(id).padStart(3)}  ${name.padEnd(44)} ${String(fields.length).padStart(3)}f  [${split}]  save=${st} prefs=${pst}`);
  built.push({
    id, slug: d.slug, name, roles: submitters.map(s => s.name), fields: fields.length, uuidById,
    layoutSha256: d.layoutSha256,
    providerDocuments: saved.documents.map((document, index) => ({
      uuid: document.uuid,
      filename: document.filename,
      localRawSha256: d.sources[index].attachmentSha256,
      providerRawSha256: savedDocumentInspections.get(document.uuid).rawSha256,
      sourceByteLength: savedDocumentInspections.get(document.uuid).sourceByteLength,
      fingerprint: savedDocumentInspections.get(document.uuid).fingerprint,
      fieldRegions: d.fields.filter((field) => field.attachmentOrder === index).map((field, order) => ({
        order, id: field.id, uuid: uuidById.get(field.id), type: field.type, owner: field.owner,
        page: field.sourcePage, x: field.x, y: field.y, w: field.w, h: field.h,
      })),
    })),
  });
}
console.log('\nbuilt ' + built.length + ' templates');

// Stage the mobile reading views into the repo so the image is self-contained.
//
// Keyed by the live template NAME, because that is the only identifier the
// signer page exposes: pages are anchored as page-<attachment_uuid>-<n> and the
// source filename never reaches the browser. This is the one place that knows
// both the slug and the template name, so the index is written here.
const index = existsSync(indexPath)
  ? JSON.parse(readFileSync(indexPath, 'utf8'))
  : {};
const stagedArtifacts = [];
for (const b of built) {
  const src = `${DIR}/${b.slug}.reflow.html`;
  if (!existsSync(src)) throw new Error(`missing reading view for ${b.slug}`);
  const mapping = new Map(Object.entries(b.uuidById || {}));
  const generatedDocument = docs.find((document) => document.slug === b.slug);
  const stampedView = stampReflowAnchors(readFileSync(src, 'utf8'), generatedDocument.fields, mapping);
  const html = stampedView.html;
  const markers = (html.match(/class="ds[^"]*"/g) || []).length;
  if (stampedView.stamped !== markers) {
    throw new Error(`${b.slug}: stamped ${stampedView.stamped} field anchor(s) but the reading ` +
      `view has ${markers} marker(s). A blank with no uuid silently becomes unfillable ` +
      'in the reflowed view, so this is a hard stop rather than a warning.');
  }
  stagedArtifacts.push({
    path: fileURLToPath(new URL(`${b.slug}.reflow.html`, REFLOW_DIR)),
    contents: html,
  });
  index[b.name] = b.slug;
}
stagedArtifacts.push({ path: fileURLToPath(indexPath), contents: JSON.stringify(index, null, 2) + '\n' });
const providerAttestation = buildProviderAttestation(built.map((template) => ({
  slug: template.slug,
  registryVersion: TEMPLATE_BY_SLUG.get(template.slug).version,
  templateId: template.id,
  templateName: template.name,
  layoutSha256: template.layoutSha256,
  reflowSha256: sha256(Buffer.from(stagedArtifacts.find((artifact) =>
    artifact.path.endsWith(`${template.slug}.reflow.html`)).contents)),
  documents: template.providerDocuments,
})));
stagedArtifacts.push({
  path: fileURLToPath(attestationPath),
  contents: `${JSON.stringify(providerAttestation, null, 2)}\n`,
});
stageCreationArtifacts({ journal: creationJournal, artifacts: stagedArtifacts });
creationJournal.complete();
console.log(`staged ${Object.keys(index).length} reading view(s) into brand/reflow/`);
} catch (error) {
  try {
    await recoverPendingCreationBatch({
      journal: creationJournal,
      listInventory: () => client.listAll('/api/templates', { what: 'failed creation transaction recovery' }),
      cleanupTemplate: (id) => client.request(
        `/api/templates/${id}`,
        { method: 'DELETE' },
        `archive failed transaction template ${id}`,
      ),
    });
  } catch (recoveryError) {
    throw new AggregateError([error, recoveryError],
      `template creation transaction failed and automatic recovery was incomplete; journal retained at ${creationJournal.path}`);
  }
  throw error;
}
} finally {
  processLock.release();
}
