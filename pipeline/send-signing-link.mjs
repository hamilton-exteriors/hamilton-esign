// Create a signing request for a worker and deliver the link over WhatsApp.
//
// Two things here are load-bearing and easy to get wrong:
//
// 1. ALWAYS append ?lang=. Without it DocuSeal guesses from Accept-Language and
//    lands on en-GB, so a Spanish speaker gets a Spanish document wrapped in an
//    English interface. On a Labor Code 2810.5 notice that defeats the point of
//    producing the Spanish version at all. Note the param is `lang`, not
//    `locale`, and the account locale setting does not affect the signer page.
//
// 2. Hired workers are contacted on WhatsApp, never Indeed, and the copy is
//    written as Alex in the first person with no sign-off.
import { readFileSync } from 'node:fs';
import { loadRw, safeName, getJson } from './safe.mjs';

const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));

/** The host a WORKER sees. Deliberately separate from SEC.url, which every API
 *  call uses.
 *
 *  Splitting them means a problem with the custom domain degrades a link to
 *  ugly, not the automation to broken: minting, countersigning, Drive filing and
 *  the signed-copy delivery all keep working on the stable Railway host. That
 *  matters here because sign.hamilton-exteriors.com spent days unroutable while
 *  looking perfectly configured, and because pointing everything at the pretty
 *  host once broke every minted link for ~40 minutes.
 *
 *  Existing links are unaffected either way: the slug is host independent and
 *  the Railway domain keeps serving. */
const PUBLIC_URL = (SEC.publicUrl || SEC.url).replace(/\/+$/, '');

const LANGS = { es: 'es', en: 'en' };

/** Per-hire document set, in signing order. Company safety programs are not here:
 *  those are Hamilton's own record and are signed once by Alex, not per worker. */
export const HIRE_PACKET = {
  en: [
    { key: 'agreement',      title: 'Employment Agreement' },
    { key: 'wage-notice',    title: 'Wage Notice - Labor Code 2810.5' },
    { key: 'acknowledgment', title: 'New Hire Policy Acknowledgment' },
    { key: 'safety-roster',  title: 'Safety Training Roster' },
  ],
  es: [
    { key: 'agreement',      title: 'Contrato de Empleo' },
    { key: 'wage-notice',    title: 'Aviso de Salario - Código Laboral 2810.5' },
    { key: 'acknowledgment', title: 'Acuse de Recibo de Políticas' },
    { key: 'safety-roster',  title: 'Registro de Capacitación en Seguridad' },
  ],
};

/** Templates that exist only in English. Sending one to a non-English speaker
 *  is a refusal, not a silent fallback: these documents have the worker attest
 *  they were provided in a language he understands. The Spanish packet above
 *  routes to the Spanish templates, so this set only guards against someone
 *  hand-picking an English title for a Spanish speaker. */
const ENGLISH_ONLY = new Set([
  'New Hire Policy Acknowledgment',
  'Safety Training Roster',
]);

/** Section A of the acknowledgment has the worker initial that he RECEIVED
 *  eight specific state notices. Sending it before those notices have actually
 *  been delivered asks him to attest to something that did not happen. Pass
 *  { pamphletsSent: true } once send-pamphlets.mjs has run for this worker. */
const REQUIRES_PAMPHLETS = new Set([
  'New Hire Policy Acknowledgment',
  'Acuse de Recibo de Políticas',
]);

const api = (path, init = {}) => fetch(`${SEC.url}${path}`, {
  ...init,
  headers: { 'X-Auth-Token': SEC.apiKey, 'Content-Type': 'application/json', ...(init.headers || {}) },
});

/** Which employer-owned checkboxes to tick, from what we already know.
 *
 *  Every one of these is Hamilton's statement, not the worker's: which rate
 *  applies, which sick-leave method Hamilton runs, which language the notice was
 *  provided in. Matching is by exact field name against the live template, so a
 *  renamed field silently drops out rather than ticking the wrong box.
 *
 *  SICK_LEAVE_METHOD is an owner ruling (2026-07-27): **accrual**. One hour of
 *  paid sick leave per 30 hours worked, capped at 40 hours / 5 days per year,
 *  per Labor Code §246(b). This is what the §2810.5 notice now states, so
 *  payroll must actually accrue it that way — the notice and the practice have
 *  to match. Changing this is a policy change, not a config tweak, and it
 *  requires a fresh notice to every employee within 7 days (§2810.5(b)). */
export const SICK_LEAVE_METHOD = 'accrual'; // 'accrual' | 'frontload'

function employerPrefill(tpl, worker) {
  // Live field names carry a position prefix from build-templates ("1/14 Roofer"),
  // so match on the part AFTER it. Exact-name matching silently ticked nothing.
  const strip = (n) => n.replace(/^\d+\/\d+\s+/, '');
  const fields = (tpl.fields || []).filter(f => f.type === 'checkbox');
  const out = {};
  const tickWhere = (pred) => {
    for (const f of fields) if (pred(strip(f.name))) out[f.name] = true;
  };

  const foreman = /foreman|capataz/i.test(worker.role || '');
  tickWhere(n => foreman
    ? /^(Foreman|Capataz)\b/i.test(n)
    : /^(Roofer|Techador)\b/i.test(n));

  // build-docs normalises these to stable keys ("Language: Spanish") precisely
  // so matching does not depend on a sentence surviving truncation.
  const es = (worker.language || 'en') === 'es';
  tickWhere(n => n === (es ? 'Language: Spanish' : 'Language: English'));

  if (SICK_LEAVE_METHOD) {
    tickWhere(n => n === (SICK_LEAVE_METHOD === 'accrual'
      ? 'Sick leave: accrual' : 'Sick leave: front load'));
  }
  return out;
}

export async function templateByName(name) {
  const r = await (await api('/api/templates?limit=100')).json();
  const t = (r.data || []).find(x => x.name === name && !x.archived_at);
  if (!t) throw new Error(`no live template named "${name}"`);
  return t;
}

/** Returns { worker: url, hamilton: url|null } with ?lang= already applied. */
export async function createSigningRequest(templateName, worker) {
  const lang = LANGS[worker.language] || 'en';
  if (lang !== 'en' && ENGLISH_ONLY.has(templateName)) {
    throw new Error(
      `refusing to send "${templateName}" to a ${lang}-speaking worker: no ${lang} version exists. ` +
      `This document asks the signer to attest it was provided in a language they understand, ` +
      `so sending it in English would make the signature itself false.`);
  }
  if (REQUIRES_PAMPHLETS.has(templateName) && !worker.pamphletsSent) {
    throw new Error(
      `refusing to send "${templateName}": its Section A has the worker initial that he received ` +
      `eight California state notices, and they have not been sent. Run ` +
      `\`node pipeline/send-pamphlets.mjs send <phone> ${lang} <rw.json>\` first, then pass ` +
      `pamphletsSent: true. Signing it beforehand records a delivery that never happened.`);
  }
  // Section A rows 11-13 attest to receiving the IIPP, the heat plan and the
  // fall protection rules. Those documents exist but nothing sent them, so those
  // three initials were false for the same reason rows 3-10 were before the
  // pamphlet step. The programs must also be SIGNED first: an unsigned, undated
  // program reads to an inspector as no program.
  if (REQUIRES_PAMPHLETS.has(templateName) && !worker.programsSent) {
    throw new Error(
      `refusing to send "${templateName}": Section A rows 11-13 have the worker initial that he ` +
      `received Hamilton's IIPP, heat illness plan and fall protection rules. Check ` +
      `\`node pipeline/send-programs.mjs status ${lang}\` — Alex must sign them, then send them ` +
      `with \`send-programs.mjs send <phone> ${lang} <rw.json>\` and pass programsSent: true.`);
  }
  const tpl = await templateByName(templateName);
  const roles = (tpl.submitters || []).map(s => s.name);

  // Prefill everything Hamilton already knows, so the worker never sees an
  // unanswered election on his own wage notice. The pay-rate boxes matter most:
  // stating the rate IS the legal purpose of a §2810.5 notice, and shipping both
  // Roofer and Foreman unmarked is the gap a worker watching for
  // misclassification would notice first.
  const employerValues = employerPrefill(tpl, worker);

  const submitters = [{
    role: 'Worker', name: worker.name, email: worker.email || undefined,
    ...(worker.startDate ? { values: { 'Start date': worker.startDate, 'Fecha de inicio': worker.startDate } } : {}),
  }];
  if (roles.includes('Hamilton')) {
    submitters.push({
      role: 'Hamilton', name: 'Alex Li', email: SEC.email,
      ...(Object.keys(employerValues).length ? { values: employerValues } : {}),
    });
  }

  const res = await api('/api/submissions', {
    method: 'POST',
    body: JSON.stringify({ template_id: tpl.id, send_email: false, send_sms: false, submitters }),
  });
  if (!res.ok) throw new Error(`submission failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  const arr = Array.isArray(out) ? out : [out];
  const url = (s, l) => `${PUBLIC_URL}/s/${s.slug}?lang=${l}`;
  const w = arr.find(s => /worker/i.test(s.role || '')) || arr[0];
  const h = arr.find(s => /hamilton/i.test(s.role || ''));
  // The countersigner is Alex; his link stays English even on a Spanish document.
  //
  // The Hamilton link is deliberately NOT returned here. DocuSeal does not gate
  // page access on signing order — with the worker's part untouched, the
  // countersigner URL renders a fully live, signable form, so Hamilton could
  // execute an employment agreement the employee has not signed. The account
  // toggle that would enforce this (`enforce_signing_order`) does not persist
  // on this edition. Order is therefore enforced by delivery: nobody holds the
  // countersign URL until the worker is actually done. Slugs are random, so an
  // undelivered link is not reachable by guessing.
  return {
    template: tpl.name, worker: url(w, lang), lang,
    submissionId: w.submission_id,
    hamiltonSubmitterId: h ? h.id : null,
    hamilton: null,
  };
}

/** Release the countersign link, but only once the worker has genuinely
 *  completed. Returns null (and says why) if they have not. */
export async function countersignLink(submissionId) {
  // getJson, not a bare fetch: a nonexistent id used to fall through to
  // "this document has no countersigner", which is a wrong ANSWER rather than an
  // error and could let someone conclude a document needs no countersignature.
  const sub = await getJson(`${SEC.url}/api/submissions/${submissionId}`,
    { 'X-Auth-Token': SEC.apiKey }, `submission ${submissionId}`);
  const subs = sub.submitters || [];
  const w = subs.find(s => /worker/i.test(s.role || ''));
  const h = subs.find(s => /hamilton/i.test(s.role || ''));
  if (!h) return { ready: false, reason: 'this document has no countersigner' };
  if (w && !w.completed_at) {
    return { ready: false, reason: `worker "${w.name}" has not signed yet`, link: null };
  }
  return { ready: true, link: `${PUBLIC_URL}/s/${h.slug}?lang=en` };
}

/** Alex, first person, no sign-off, directive tied to a consequence. */
export function message(worker, link, docTitle) {
  if ((worker.language || 'en') === 'es') {
    return `Aquí está tu ${docTitle} para firmar: ${link}\n\nNecesito que lo firmes hoy.`;
  }
  return `Here is your ${docTitle} to sign: ${link}\n\nI need this signed today.`;
}

export async function sendWhatsApp(to, body, rwPath) {
  const V = loadRw(rwPath);
  const r = await fetch(`https://${V.RAILWAY_PUBLIC_DOMAIN}/internal/whatsapp/send-text`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${V.PLATFORM_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

/** Push the signed PDF itself back to the worker over WhatsApp.
 *
 * Labor Code §432 entitles an employee to a copy of anything they sign, and
 * the wage notice itself carries a field reading "Copy given to Employee on".
 * DocuSeal's own download link expires 30 minutes after signing and is never
 * emailed anywhere, since no worker email is collected — so without this the
 * worker who just signed his employment agreement walks away with nothing.
 *
 * Gated on the SUBMISSION being completed, not just the worker's own part: on
 * a two-party document the PDF only carries both signatures once Hamilton has
 * countersigned, and sending an incomplete PDF as "here is your signed copy"
 * would be worse than sending nothing. */
export async function deliverSignedCopy(submissionId, worker, rwPath) {
  const sub = await getJson(`${SEC.url}/api/submissions/${submissionId}`,
    { 'X-Auth-Token': SEC.apiKey }, `submission ${submissionId}`);
  const subs = sub.submitters || [];
  // "no submitters" and "not fully signed" are different facts; a submission
  // with none is a broken record, not a document waiting on someone.
  if (!subs.length) return { sent: false, reason: `submission ${submissionId} has no submitters` };
  const pending = subs.filter(s => !s.completed_at);
  if (pending.length) {
    return { sent: false, reason: `not fully signed yet: waiting on ${pending.map(s => s.name).join(', ')}` };
  }
  const docs = await (await api(`/api/submissions/${submissionId}/documents`)).json();
  if (!docs.documents?.length) return { sent: false, reason: 'no documents on this submission' };

  const lang = LANGS[worker.language] || 'en';
  const date = (sub.completed_at || '').slice(0, 10) || 'signed';
  const results = [];
  for (const doc of docs.documents) {
    // safeName, not the raw name: "Ana Maria / Marie" produced a broken filename
    // and "///" produced an empty one.
    const filename = `${safeName(sub.template?.name || doc.name, 'Document')} - ${safeName(worker.name)} - ${date}.pdf`;
    const caption = lang === 'es'
      ? 'Aquí está tu copia firmada, para tus archivos.'
      : "Here's your signed copy, for your records.";
    const res = await sendDocument(worker.phone, doc.url, filename, caption, rwPath);
    results.push({ filename, status: res.status, ok: res.status === 200 });
  }
  return { sent: results.every(r => r.ok), results };
}

async function sendDocument(to, link, filename, caption, rwPath) {
  const V = loadRw(rwPath);
  const r = await fetch(`https://${V.RAILWAY_PUBLIC_DOMAIN}/internal/whatsapp/send-document`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${V.PLATFORM_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, link, filename, caption }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

// Only run the CLI when this file IS the entry point. Without the guard,
// importing this module executes its CLI against the importing script's argv —
// `run-packet.mjs plan ...` made it look for a template literally named "plan".
const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

// --- CLI ---------------------------------------------------------------------
if (!IS_MAIN) {
  // imported as a library; do nothing
} else if (process.argv[2] === 'countersign') {
  // node send-signing-link.mjs countersign <submissionId> [--send <rw.json>]
  const submissionId = process.argv[3];
  const sendIdx = process.argv.indexOf('--send');
  const c = await countersignLink(submissionId);
  if (!c.ready) { console.log(`not ready: ${c.reason}`); process.exit(0); }
  console.log(`countersign link: ${c.link}`);
  if (sendIdx > 0) {
    const to = process.argv[4];
    const res = await sendWhatsApp(to, `Signed and ready for your countersignature: ${c.link}`, process.argv[sendIdx + 1]);
    console.log(`sent to Alex -> HTTP ${res.status}`);
  }
} else if (process.argv[2] === 'deliver') {
  // node send-signing-link.mjs deliver <submissionId> <name> <phone> <en|es> <rw.json>
  const [, , , submissionId, name, phone, language, rwPath] = process.argv;
  const r = await deliverSignedCopy(submissionId, { name, phone, language }, rwPath);
  console.log(r.sent ? `delivered: ${r.results.map(x => x.filename).join(', ')}` : `not sent: ${r.reason || JSON.stringify(r.results)}`);
} else if (process.argv[2]) {
  // node send-signing-link.mjs "<template name>" <name> <phone> <en|es> [--send <rw.json>]
  const [, , tplName, name, phone, language] = process.argv;
  const sendIdx = process.argv.indexOf('--send');
  const worker = { name, phone, language: language || 'en' };
  const req = await createSigningRequest(tplName, worker);
  const msg = message(worker, req.worker, req.template);
  console.log(`template : ${req.template}`);
  console.log(`lang     : ${req.lang}`);
  console.log(`worker   : ${req.worker}`);
  console.log(`submission: ${req.submissionId}`);
  console.log(`\nmessage to ${phone}:\n${msg}\n`);
  if (sendIdx > 0) {
    const res = await sendWhatsApp(phone, msg, process.argv[sendIdx + 1]);
    console.log(`sent -> HTTP ${res.status} ${res.body}`);
  } else {
    console.log('(dry run — pass --send <rw.json> to actually deliver)');
  }
}
