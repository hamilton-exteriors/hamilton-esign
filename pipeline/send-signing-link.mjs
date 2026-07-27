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

const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));

const LANGS = { es: 'es', en: 'en' };

/** Per-hire document set, in signing order. Company safety programs are not here:
 *  those are Hamilton's own record and are signed once by Alex, not per worker. */
export const HIRE_PACKET = {
  en: [
    { key: 'agreement',      title: 'Employment Agreement (At-Will)' },
    { key: 'wage-notice',    title: 'Wage Notice - Labor Code 2810.5' },
    { key: 'acknowledgment', title: 'New Hire Policy Acknowledgment' },
    { key: 'safety-roster',  title: 'Safety Training Roster' },
  ],
  es: [
    { key: 'agreement',      title: 'Contrato de Empleo (Voluntad de las Partes)' },
    { key: 'wage-notice',    title: 'Aviso de Salario - Codigo Laboral 2810.5' },
    { key: 'acknowledgment', title: 'New Hire Policy Acknowledgment' },
    { key: 'safety-roster',  title: 'Safety Training Roster' },
  ],
};

const api = (path, init = {}) => fetch(`${SEC.url}${path}`, {
  ...init,
  headers: { 'X-Auth-Token': SEC.apiKey, 'Content-Type': 'application/json', ...(init.headers || {}) },
});

export async function templateByName(name) {
  const r = await (await api('/api/templates?limit=100')).json();
  const t = (r.data || []).find(x => x.name === name && !x.archived_at);
  if (!t) throw new Error(`no live template named "${name}"`);
  return t;
}

/** Returns { worker: url, hamilton: url|null } with ?lang= already applied. */
export async function createSigningRequest(templateName, worker) {
  const lang = LANGS[worker.language] || 'en';
  const tpl = await templateByName(templateName);
  const roles = (tpl.submitters || []).map(s => s.name);

  const submitters = [{ role: 'Worker', name: worker.name, email: worker.email || undefined }];
  if (roles.includes('Hamilton')) {
    submitters.push({ role: 'Hamilton', name: 'Alex Li', email: SEC.email });
  }

  const res = await api('/api/submissions', {
    method: 'POST',
    body: JSON.stringify({ template_id: tpl.id, send_email: false, send_sms: false, submitters }),
  });
  if (!res.ok) throw new Error(`submission failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  const arr = Array.isArray(out) ? out : [out];
  const url = (s, l) => `${SEC.url}/s/${s.slug}?lang=${l}`;
  const w = arr.find(s => /worker/i.test(s.role || '')) || arr[0];
  const h = arr.find(s => /hamilton/i.test(s.role || ''));
  // The countersigner is Alex; his link stays English even on a Spanish document.
  return { template: tpl.name, worker: url(w, lang), hamilton: h ? url(h, 'en') : null, lang };
}

/** Alex, first person, no sign-off, directive tied to a consequence. */
export function message(worker, link, docTitle) {
  if ((worker.language || 'en') === 'es') {
    return `Aqui esta tu ${docTitle} para firmar: ${link}\n\nNecesito que lo firmes hoy.`;
  }
  return `Here is your ${docTitle} to sign: ${link}\n\nI need this signed today.`;
}

export async function sendWhatsApp(to, body, rwPath) {
  const V = JSON.parse(readFileSync(rwPath, 'utf8'));
  const r = await fetch(`https://${V.RAILWAY_PUBLIC_DOMAIN}/internal/whatsapp/send-text`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${V.PLATFORM_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

// --- CLI ---------------------------------------------------------------------
// node send-signing-link.mjs "<template name>" <name> <phone> <en|es> [--send <rw.json>]
if (process.argv[2]) {
  const [, , tplName, name, phone, language] = process.argv;
  const sendIdx = process.argv.indexOf('--send');
  const worker = { name, phone, language: language || 'en' };
  const req = await createSigningRequest(tplName, worker);
  const msg = message(worker, req.worker, req.template);
  console.log(`template : ${req.template}`);
  console.log(`lang     : ${req.lang}`);
  console.log(`worker   : ${req.worker}`);
  if (req.hamilton) console.log(`hamilton : ${req.hamilton}`);
  console.log(`\nmessage to ${phone}:\n${msg}\n`);
  if (sendIdx > 0) {
    const res = await sendWhatsApp(phone, msg, process.argv[sendIdx + 1]);
    console.log(`sent -> HTTP ${res.status} ${res.body}`);
  } else {
    console.log('(dry run — pass --send <rw.json> to actually deliver)');
  }
}
