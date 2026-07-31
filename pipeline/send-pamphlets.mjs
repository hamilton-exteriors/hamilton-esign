// Deliver the California new-hire pamphlets before the policy acknowledgment.
// Every URL is verified first, and per-item delivery state makes retries idempotent.
import { loadRw, safeName } from './safe.mjs';
import { postWhatsApp, sendIntroOnce } from './whatsapp-delivery.mjs';

import { STATUTORY_PAMPHLETS } from './statutory-assets.mjs';

export const PAMPHLETS = STATUTORY_PAMPHLETS;

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
