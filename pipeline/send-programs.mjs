// Deliver the current, fully signed Cal/OSHA programs to a worker. Historical
// submissions with the same title do not satisfy the current-template gate.
import { loadRw, safeName } from './safe.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { postWhatsApp, sendIntroOnce } from './whatsapp-delivery.mjs';

const client = createDocusealClient();

export const PROGRAMS = {
  en: [
    { row: 11, title: 'Injury and Illness Prevention Program (IIPP)' },
    { row: 12, title: 'Heat Illness Prevention Plan' },
    { row: 13, title: 'Fall Protection Program' },
    { row: null, title: 'Code of Safe Practices' },
  ],
  es: [
    { row: 11, title: 'Injury and Illness Prevention Program (IIPP)' },
    { row: 12, title: 'Plan de Prevención de Enfermedades por Calor' },
    { row: 13, title: 'Fall Protection Program' },
    { row: null, title: 'Code of Safe Practices' },
  ],
};

async function signedProgram(title, submissions) {
  const template = await client.templateByName(title);
  const complete = submissions
    .filter((entry) => !entry.archived_at && entry.template?.id === template.id)
    .filter((entry) => {
      const submitters = entry.submitters || [];
      return submitters.length === 1 &&
        /hamilton/i.test(submitters[0].role || '') &&
        submitters[0].name === 'Alex Li' &&
        Boolean(submitters[0].completed_at);
    })
    .sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
  if (!complete.length) return null;
  const documents = await client.request(`/api/submissions/${complete[0].id}/documents`, {},
    `signed documents for ${title}`);
  const url = documents.documents?.[0]?.url;
  return url ? {
    url,
    signedAt: complete[0].completed_at,
    templateId: template.id,
    submissionId: complete[0].id,
  } : null;
}

export async function programStatus(language = 'en') {
  const submissions = await client.listAll('/api/submissions', { what: 'submission inventory' });
  const out = [];
  for (const program of PROGRAMS[language === 'es' ? 'es' : 'en']) {
    const signed = await signedProgram(program.title, submissions);
    out.push({ ...program, signed: Boolean(signed), ...signed });
  }
  return out;
}

export async function sendPrograms(worker, rwPath, previousState = {}) {
  const lang = worker.language === 'es' ? 'es' : 'en';
  const status = await programStatus(lang);
  const unsigned = status.filter((entry) => !entry.signed);
  if (unsigned.length) {
    return {
      sent: false,
      deliveryState: previousState,
      reason: `Alex has not signed ${unsigned.length} of ${status.length} current safety programs: ` +
        `${unsigned.map((entry) => entry.title).join('; ')}.`,
    };
  }

  const rw = loadRw(rwPath);
  const state = { intro: Boolean(previousState.intro), documents: { ...(previousState.documents || {}) } };
  try {
    const intro = lang === 'es'
      ? 'Aquí están los programas de seguridad de Hamilton. Guárdalos en tu teléfono.'
      : "Here are Hamilton's safety programs. Keep these on your phone.";
    await sendIntroOnce(rw, worker.phone, intro, state);
    for (const program of status) {
      const key = String(program.submissionId);
      if (state.documents[key]) continue;
      await postWhatsApp(rw, 'send-document', {
        to: worker.phone,
        link: program.url,
        filename: `${safeName(program.title)}.pdf`,
        caption: program.title,
      });
      state.documents[key] = true;
    }
  } catch (error) {
    return { sent: false, deliveryState: state, reason: error.message };
  }
  return { sent: true, count: status.length, deliveryState: state };
}

function usage() {
  console.error('usage:');
  console.error('  node send-programs.mjs status <en|es>');
  console.error('  node send-programs.mjs send <phone> <en|es> <rw.json>');
}

const IS_MAIN = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (IS_MAIN) {
  if (process.argv[2] === 'status' && ['en', 'es'].includes(process.argv[3] || 'en')) {
    const status = await programStatus(process.argv[3] || 'en');
    for (const program of status) {
      console.log(`${program.signed ? 'SIGNED  ' : 'UNSIGNED'} ${program.title}${program.signedAt ? `  ${program.signedAt.slice(0, 10)}` : ''}`);
    }
    console.log(`\n${status.filter((program) => program.signed).length}/${status.length} signed`);
    if (status.some((program) => !program.signed)) process.exitCode = 1;
  } else if (process.argv[2] === 'send' && process.argv[3] &&
    ['en', 'es'].includes(process.argv[4]) && process.argv[5]) {
    const result = await sendPrograms({ phone: process.argv[3], language: process.argv[4] }, process.argv[5]);
    if (!result.sent) { console.error(`NOT sent: ${result.reason}`); process.exit(1); }
    console.log(`sent ${result.count} programs`);
  } else {
    usage();
    process.exit(1);
  }
}
