// Deliver Hamilton's signed Cal/OSHA programs to a worker.
//
// Acknowledgment Section A rows 11-13 have the worker initial that he received
// the IIPP summary, the heat illness plan and the fall protection rules. Those
// documents exist and are real, but nothing ever sent them to a worker, so those
// three initials were attestations to something that had not happened — the same
// defect as rows 3-10 before the pamphlet step, and the same defect as the
// acknowledgment that once referenced an IIPP which did not exist at all.
//
// Two things make this stricter than the pamphlet step:
//
//  1. It sends the SIGNED programs, not drafts. An unsigned, undated safety
//     program reads to a Cal/OSHA inspector as no program, so sending a draft
//     would let the worker initial receipt of something that does not yet count.
//  2. It therefore REFUSES until Alex has countersigned each one, which is a
//     real outstanding blocker rather than something to work around.
//
// §3203 requires the IIPP be available to employees and §3395 requires the heat
// plan at the worksite, so sending each worker his own copy is the substance of
// the requirement, not paperwork about it.
import { readFileSync } from 'node:fs';
import { loadRw, safeName, driveQuote } from './safe.mjs';

const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));
const api = (p) => fetch(`${SEC.url}${p}`, { headers: { 'X-Auth-Token': SEC.apiKey } }).then(r => r.json());

/** Acknowledgment rows 11-13, plus the Code of Safe Practices, which §1509(b)
 *  requires be posted at every jobsite and which the roster also covers. */
export const PROGRAMS = {
  en: [
    { row: 11, title: 'Injury and Illness Prevention Program (IIPP)' },
    { row: 12, title: 'Heat Illness Prevention Plan' },
    { row: 13, title: 'Fall Protection Program' },
    { row: null, title: 'Code of Safe Practices' },
  ],
  es: [
    { row: 11, title: 'Injury and Illness Prevention Program (IIPP)' }, // EN only
    { row: 12, title: 'Plan de Prevención de Enfermedades por Calor' },
    { row: 13, title: 'Fall Protection Program' },                      // EN only
    { row: null, title: 'Code of Safe Practices' },                     // bilingual in one doc
  ],
};

/** Find the most recent FULLY SIGNED submission of a template, and its PDF. */
async function signedProgram(title) {
  const list = await api('/api/submissions?limit=100');
  const done = (list.data || [])
    .filter(s => !s.archived_at && s.template?.name === title)
    .filter(s => (s.submitters || []).length && (s.submitters || []).every(x => x.completed_at))
    .sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
  if (!done.length) return null;
  const docs = await api(`/api/submissions/${done[0].id}/documents`);
  const url = docs.documents?.[0]?.url;
  return url ? { url, signedAt: done[0].completed_at } : null;
}

/** Which programs are signed and which are not. Read-only; call before sending. */
export async function programStatus(language = 'en') {
  const out = [];
  for (const p of PROGRAMS[language === 'es' ? 'es' : 'en']) {
    const s = await signedProgram(p.title);
    out.push({ ...p, signed: !!s, url: s?.url, signedAt: s?.signedAt });
  }
  return out;
}

/** Send the signed programs, or refuse and say which signatures are missing. */
export async function sendPrograms(worker, rwPath) {
  const lang = worker.language === 'es' ? 'es' : 'en';
  const status = await programStatus(lang);
  const unsigned = status.filter(s => !s.signed);
  if (unsigned.length) {
    return { sent: false, reason:
      `Alex has not signed ${unsigned.length} of ${status.length} safety programs: ` +
      `${unsigned.map(u => u.title).join('; ')}. An unsigned, undated program reads to an ` +
      `inspector as no program, so a worker must not initial receipt of it.` };
  }
  const rw = loadRw(rwPath);
  const intro = lang === 'es'
    ? 'Aquí están los programas de seguridad de Hamilton. Guárdalos en tu teléfono.'
    : "Here are Hamilton's safety programs. Keep these on your phone.";
  const results = [];
  const post = async (path, body) => {
    const r = await fetch(`https://${rw.RAILWAY_PUBLIC_DOMAIN}/internal/whatsapp/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rw.PLATFORM_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.status;
  };
  results.push(await post('send-text', { to: worker.phone, body: intro }));
  for (const p of status) {
    results.push(await post('send-document', {
      to: worker.phone, link: p.url,
      filename: `${p.title}.pdf`.replace(/[\\/:*?"<>|]/g, ''),
      caption: p.title,
    }));
  }
  return { sent: results.every(s => s === 200), count: status.length, results };
}

// --- CLI ---------------------------------------------------------------------
const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (IS_MAIN && process.argv[2] === 'status') {
  const s = await programStatus(process.argv[3] || 'en');
  for (const p of s) console.log(`${p.signed ? 'SIGNED  ' : 'UNSIGNED'} ${p.title}${p.signedAt ? '  ' + p.signedAt.slice(0, 10) : ''}`);
  console.log(`\n${s.filter(p => p.signed).length}/${s.length} signed`);
} else if (IS_MAIN && process.argv[2] === 'send') {
  const r = await sendPrograms({ phone: process.argv[3], language: process.argv[4] }, process.argv[5]);
  console.log(r.sent ? `sent ${r.count} programs` : `NOT sent: ${r.reason}`);
}
