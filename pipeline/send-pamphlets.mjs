// Deliver the California new-hire pamphlets over WhatsApp, BEFORE the policy
// acknowledgment is sent.
//
// Why this exists: Section A of the acknowledgment has the worker initial that
// he received eight specific state notices. The e-sign flow never sent any of
// them, so every one of those initials was an attestation to something that had
// not happened — the same defect as the acknowledgment that referenced an IIPP
// which did not exist. A signed record of a delivery that never occurred is
// worse than no record.
//
// Every URL below was fetched and confirmed to return HTTP 200 with
// content-type application/pdf from the issuing agency (EDD, DIR/DWC, DLSE,
// CRD) on 2026-07-27. Do not add an entry without checking it the same way —
// a dead link in this list recreates the exact problem it was written to fix.
import { readFileSync } from 'node:fs';

/** Acknowledgment Section A rows 3-10, in the order they appear on the sheet. */
export const PAMPHLETS = {
  en: [
    { row: 3,  name: 'DWC Time of Hire pamphlet',                 url: 'https://www.dir.ca.gov/dwc/DWCPamphlets/TimeOfHireNotice.pdf' },
    { row: 4,  name: 'Predesignation of personal physician (DWC 9783)', url: 'https://www.dir.ca.gov/dwc/forms/dwcform_9783.pdf' },
    { row: 5,  name: 'DE 2320 For Your Benefit',                   url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2320.pdf' },
    { row: 6,  name: 'DE 2515 Disability Insurance Provisions',    url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2515.pdf' },
    { row: 7,  name: 'DE 2511 Paid Family Leave',                  url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2511.pdf' },
    { row: 8,  name: 'Paid sick leave notice',                     url: 'https://www.dir.ca.gov/dlse/Publications/Paid_Sick_Days_Poster_Template_(11_2014).pdf' },
    { row: 9,  name: 'Sexual harassment prevention (CRD)',         url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2022/12/Sexual-Harassment-Poster_ENG.pdf' },
    { row: 10, name: 'Rights of victims of domestic violence, sexual assault and stalking', url: 'https://www.dir.ca.gov/dlse/victims_of_domestic_violence_leave_notice.pdf' },
  ],
  es: [
    { row: 3,  name: 'Folleto DWC al momento de contratación',     url: 'https://www.dir.ca.gov/dwc/DWCPamphlets/TimeOfHireNotice_Spanish.pdf' },
    // DWC 9783 is published in English only; sent as-is rather than omitted,
    // because the worker must be offered the predesignation form either way.
    { row: 4,  name: 'Predesignación de médico personal (DWC 9783)', url: 'https://www.dir.ca.gov/dwc/forms/dwcform_9783.pdf' },
    { row: 5,  name: 'DE 2320 Para Su Beneficio',                  url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2320s.pdf' },
    { row: 6,  name: 'DE 2515 Seguro de Incapacidad',              url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2515s.pdf' },
    { row: 7,  name: 'DE 2511 Permiso Familiar Pagado',            url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2511s.pdf' },
    { row: 8,  name: 'Aviso de días de enfermedad pagados',        url: 'https://www.dir.ca.gov/dlse/Publications/Paid_Sick_Days_Poster_Template_(11_2014).pdf' },
    { row: 9,  name: 'Acoso sexual — hoja informativa (CRD)',      url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2020/04/Sexual-Harassment-Fact-Sheet_SP.pdf' },
    { row: 10, name: 'Derechos de víctimas de violencia doméstica, agresión sexual y acecho', url: 'https://www.dir.ca.gov/dlse/Victims_of_Domestic_Violence_Leave_Notice_Spanish.pdf' },
  ],
};

const wa = (rwPath) => JSON.parse(readFileSync(rwPath, 'utf8'));

async function post(rw, path, body) {
  const r = await fetch(`https://${rw.RAILWAY_PUBLIC_DOMAIN}/internal/whatsapp/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rw.PLATFORM_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.text()).slice(0, 160) };
}

/** Confirm every link still serves a PDF before sending any of them. A 404 in
 *  this list would produce the exact false record this module prevents. */
export async function verifyAll(lang = 'en') {
  const out = [];
  for (const p of PAMPHLETS[lang]) {
    try {
      const r = await fetch(p.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      const ct = r.headers.get('content-type') || '';
      out.push({ ...p, ok: r.status === 200 && /pdf/i.test(ct), status: r.status });
    } catch (e) { out.push({ ...p, ok: false, status: e.message.slice(0, 40) }); }
  }
  return out;
}

/** Send all eight, then a summary line. Refuses if any link is dead. */
export async function sendPamphlets(worker, rwPath) {
  const lang = worker.language === 'es' ? 'es' : 'en';
  const checked = await verifyAll(lang);
  const dead = checked.filter(c => !c.ok);
  if (dead.length) {
    return { sent: false, reason: `refusing to send: ${dead.length} dead link(s) — ` +
      dead.map(d => `${d.name} (${d.status})`).join('; ') };
  }
  const rw = wa(rwPath);
  const intro = lang === 'es'
    ? 'Antes de firmar el acuse de recibo, aquí están los avisos del estado de California que te corresponden. Son 8 documentos.'
    : 'Before you sign the acknowledgment, here are the California state notices you are entitled to. Eight documents.';
  const results = [await post(rw, 'send-text', { to: worker.phone, body: intro })];
  for (const p of checked) {
    results.push(await post(rw, 'send-document', {
      to: worker.phone, link: p.url,
      filename: `${p.name}.pdf`.replace(/[\\/:*?"<>|]/g, ''),
      caption: `${p.row}. ${p.name}`,
    }));
  }
  return { sent: results.every(r => r.status === 200), count: checked.length, results };
}

// --- CLI ---------------------------------------------------------------------
// node send-pamphlets.mjs verify <en|es>
// node send-pamphlets.mjs send <phone> <en|es> <rw.json>
const [, , cmd, a, b, c] = process.argv;
if (cmd === 'verify') {
  const r = await verifyAll(a || 'en');
  for (const x of r) console.log(`${x.ok ? 'OK  ' : 'DEAD'} ${String(x.row).padStart(2)}. ${x.name}`);
  console.log(`\n${r.filter(x => x.ok).length}/${r.length} live`);
} else if (cmd === 'send') {
  const r = await sendPamphlets({ phone: a, language: b }, c);
  console.log(r.sent ? `sent ${r.count} pamphlets to ${a}` : `NOT sent: ${r.reason || JSON.stringify(r.results)}`);
}
