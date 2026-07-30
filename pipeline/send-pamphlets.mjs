// Deliver the California new-hire pamphlets before the policy acknowledgment.
// Every URL is verified first, and per-item delivery state makes retries idempotent.
import { loadRw, safeName } from './safe.mjs';
import { postWhatsApp, sendIntroOnce } from './whatsapp-delivery.mjs';

export const PAMPHLETS = {
  en: [
    { row: 3, name: 'DWC Time of Hire pamphlet', url: 'https://www.dir.ca.gov/dwc/DWCPamphlets/TimeOfHireNotice.pdf' },
    { row: 4, name: 'Predesignation of personal physician (DWC 9783)', url: 'https://www.dir.ca.gov/dwc/forms/dwcform_9783.pdf' },
    { row: 5, name: 'DE 2320 For Your Benefit', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2320.pdf' },
    { row: 6, name: 'DE 2515 Disability Insurance Provisions', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2515.pdf' },
    { row: 7, name: 'DE 2511 Paid Family Leave', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2511.pdf' },
    { row: 8, name: 'Paid sick leave notice', url: 'https://www.dir.ca.gov/dlse/Publications/Paid_Sick_Days_Poster_Template_(11_2014).pdf' },
    { row: 9, name: 'Sexual harassment prevention (CRD)', url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2022/12/Sexual-Harassment-Poster_ENG.pdf' },
    { row: 10, name: 'Rights of victims of domestic violence, sexual assault and stalking', url: 'https://www.dir.ca.gov/dlse/victims_of_domestic_violence_leave_notice.pdf' },
  ],
  es: [
    { row: 3, name: 'Folleto DWC al momento de contratación', url: 'https://www.dir.ca.gov/dwc/DWCPamphlets/TimeOfHireNotice_Spanish.pdf' },
    { row: 4, name: 'Predesignación de médico personal (DWC 9783)', url: 'https://www.dir.ca.gov/dwc/forms/dwcform_9783.pdf' },
    { row: 5, name: 'DE 2320 Para Su Beneficio', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2320s.pdf' },
    { row: 6, name: 'DE 2515 Seguro de Incapacidad', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2515s.pdf' },
    { row: 7, name: 'DE 2511 Permiso Familiar Pagado', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2511s.pdf' },
    { row: 8, name: 'Aviso de días de enfermedad pagados', url: 'https://www.dir.ca.gov/dlse/Publications/Paid_Sick_Days_Poster_Template_(11_2014).pdf' },
    { row: 9, name: 'Acoso sexual - hoja informativa (CRD)', url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2020/04/Sexual-Harassment-Fact-Sheet_SP.pdf' },
    { row: 10, name: 'Derechos de víctimas de violencia doméstica, agresión sexual y acecho', url: 'https://www.dir.ca.gov/dlse/Victims_of_Domestic_Violence_Leave_Notice_Spanish.pdf' },
  ],
};

export function pamphletCopy(language = 'en') {
  const lang = language === 'es' ? 'es' : 'en';
  return {
    intro: lang === 'es'
      ? 'Antes de firmar el acuse de recibo, aquí están los avisos del estado de California que te corresponden. Son 8 documentos.'
      : 'Before you sign the acknowledgment, here are the California state notices you are entitled to. Eight documents.',
    documents: PAMPHLETS[lang].map((pamphlet) => ({
      filename: `${safeName(pamphlet.name)}.pdf`,
      caption: `${pamphlet.row}. ${pamphlet.name}`,
    })),
  };
}

export async function verifyAll(lang = 'en') {
  const key = lang === 'es' ? 'es' : 'en';
  const out = [];
  for (const pamphlet of PAMPHLETS[key]) {
    try {
      const response = await fetch(pamphlet.url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const contentType = response.headers.get('content-type') || '';
      out.push({ ...pamphlet, ok: response.status === 200 && /pdf/i.test(contentType), status: response.status });
    } catch (error) {
      out.push({ ...pamphlet, ok: false, status: error.message.slice(0, 40) });
    }
  }
  return out;
}

export async function sendPamphlets(worker, rwPath, previousState = {}) {
  const lang = worker.language === 'es' ? 'es' : 'en';
  const checked = await verifyAll(lang);
  const dead = checked.filter((entry) => !entry.ok);
  if (dead.length) {
    return {
      sent: false,
      deliveryState: previousState,
      reason: `refusing to send: ${dead.length} dead link(s) - ` +
        dead.map((entry) => `${entry.name} (${entry.status})`).join('; '),
    };
  }

  const rw = loadRw(rwPath);
  const state = { intro: Boolean(previousState.intro), documents: { ...(previousState.documents || {}) } };
  try {
    const preview = pamphletCopy(lang);
    await sendIntroOnce(rw, worker.phone, preview.intro, state);
    for (const pamphlet of checked) {
      const key = String(pamphlet.row);
      if (state.documents[key]) continue;
      await postWhatsApp(rw, 'send-document', {
        to: worker.phone,
        link: pamphlet.url,
        filename: `${safeName(pamphlet.name)}.pdf`,
        caption: `${pamphlet.row}. ${pamphlet.name}`,
      });
      state.documents[key] = true;
    }
  } catch (error) {
    return { sent: false, deliveryState: state, reason: error.message };
  }
  return { sent: true, count: checked.length, deliveryState: state };
}

function usage() {
  console.error('usage:');
  console.error('  node send-pamphlets.mjs verify <en|es>');
  console.error('  delivery is available only through pipeline/onboarding.mjs');
}

const IS_MAIN = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (IS_MAIN) {
  const [, , command, first, second, third] = process.argv;
  if (command === 'verify' && ['en', 'es'].includes(first || 'en')) {
    const results = await verifyAll(first || 'en');
    for (const result of results) {
      console.log(`${result.ok ? 'OK  ' : 'DEAD'} ${String(result.row).padStart(2)}. ${result.name}`);
    }
    console.log(`\n${results.filter((entry) => entry.ok).length}/${results.length} live`);
    if (results.some((entry) => !entry.ok)) process.exitCode = 1;
  } else if (command === 'send') {
    console.error('direct pamphlet delivery is disabled; use the approval-gated onboarding workflow');
    process.exit(1);
  } else {
    usage();
    process.exit(1);
  }
}
