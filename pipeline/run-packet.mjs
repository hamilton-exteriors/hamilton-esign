// Orchestrate a worker's whole hire packet instead of four disconnected links.
//
// The gap this closes: sending four separate links, each opening cold on a
// multi-page legal document with no framing, no count, and no idea whether
// anything follows. A worker finishes document one and nothing tells him — or
// us — that three remain. The signing pages themselves were designed; the
// journey between them was not.
//
// Order matters and is enforced, not documented:
//   1. pamphlets  — the acknowledgment has him initial receipt of them
//   2. agreement  — what the job is
//   3. wage notice — what he is paid (§2810.5)
//   4. acknowledgment — what he received
//   5. safety roster — what he was trained on
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { HIRE_PACKET, createSigningRequest, sendWhatsApp, deliverSignedCopy } from './send-signing-link.mjs';
import { sendPamphlets } from './send-pamphlets.mjs';

const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));
const api = (p) => fetch(`${SEC.url}${p}`, { headers: { 'X-Auth-Token': SEC.apiKey } }).then(r => r.json());

// No em or en dashes in anything a worker reads: the owner flagged them as
// reading AI-generated, and they also corrupt when a message goes out through a
// shell. Plain hyphens, commas and colons only.
const copy = {
  en: {
    intro: (n) => `You're hired, welcome aboard. There are ${n} documents to sign, about 15 minutes total. ` +
      `I'll send them one at a time so you're never looking at more than one. ` +
      `Questions on any of it, call me at (650) 977-3241.`,
    doc: (i, n, title, link) => `${i} of ${n}: ${title}\n${link}`,
    done: (n) => `That's all ${n} signed. I'll countersign and your copies come back here.`,
  },
  es: {
    intro: (n) => `Quedas contratado, bienvenido. Son ${n} documentos para firmar, unos 15 minutos en total. ` +
      `Te los mando de uno en uno para que nunca veas más de uno a la vez. ` +
      `Cualquier duda, llámame al (650) 977-3241.`,
    doc: (i, n, title, link) => `${i} de ${n}: ${title}\n${link}`,
    done: (n) => `Ya están firmados los ${n}. Yo firmo después y tus copias regresan aquí.`,
  },
};

/** Has this submission been fully signed by everyone? */
async function isComplete(submissionId) {
  const s = await api(`/api/submissions/${submissionId}`);
  const subs = s.submitters || [];
  return subs.length > 0 && subs.every(x => x.completed_at);
}

/** Has just the worker finished their part? */
async function workerDone(submissionId) {
  const s = await api(`/api/submissions/${submissionId}`);
  const w = (s.submitters || []).find(x => /worker/i.test(x.role || ''));
  return !!w?.completed_at;
}

/**
 * Start a packet: send the framing message, the pamphlets, then document 1.
 * Returns the state to persist so `advance()` can continue it later.
 */
export async function startPacket(worker, rwPath, { dryRun = true } = {}) {
  const lang = worker.language === 'es' ? 'es' : 'en';
  const docs = HIRE_PACKET[lang];
  const t = copy[lang];
  const plan = { worker, lang, total: docs.length, sent: [], dryRun };

  plan.intro = t.intro(docs.length);
  if (!dryRun) {
    const pam = await sendPamphlets(worker, rwPath);
    if (!pam.sent) return { ...plan, aborted: `pamphlets not sent: ${pam.reason}` };
    plan.pamphlets = pam.count;
    await sendWhatsApp(worker.phone, plan.intro, rwPath);
  }

  const first = await createSigningRequest(docs[0].title, { ...worker, pamphletsSent: true });
  plan.sent.push({ i: 1, title: first.template, submissionId: first.submissionId, link: first.worker });
  plan.message = t.doc(1, docs.length, first.template, first.worker);
  if (!dryRun) await sendWhatsApp(worker.phone, plan.message, rwPath);
  return plan;
}

/**
 * Advance a packet: if the worker finished the document we last sent, send the
 * next one. Idempotent — safe to poll. Returns what it did.
 */
export async function advance(state, rwPath, { dryRun = true } = {}) {
  const { worker, lang } = state;
  const docs = HIRE_PACKET[lang];
  const t = copy[lang];
  const last = state.sent[state.sent.length - 1];

  if (!await workerDone(last.submissionId)) {
    return { action: 'wait', on: `${last.i} of ${docs.length}: ${last.title}` };
  }

  // Signed copies go back per document, once BOTH parties are done with it.
  for (const s of state.sent) {
    if (s.delivered) continue;
    if (await isComplete(s.submissionId) && !dryRun) {
      const d = await deliverSignedCopy(s.submissionId, worker, rwPath);
      if (d.sent) s.delivered = true;
    }
  }

  const nextIdx = state.sent.length;
  if (nextIdx >= docs.length) {
    const msg = t.done(docs.length);
    if (!dryRun) await sendWhatsApp(worker.phone, msg, rwPath);
    return { action: 'packet-complete', message: msg, state };
  }

  const next = await createSigningRequest(docs[nextIdx].title, { ...worker, pamphletsSent: true });
  const msg = t.doc(nextIdx + 1, docs.length, next.template, next.worker);
  state.sent.push({ i: nextIdx + 1, title: next.template, submissionId: next.submissionId, link: next.worker });
  if (!dryRun) await sendWhatsApp(worker.phone, msg, rwPath);
  return { action: 'sent-next', message: msg, state };
}

// State lives in a file so `advance` can actually resume a packet. The earlier
// version printed `{lang, sent:[id]}`, which advance() cannot consume — it needs
// `worker` and `sent[].i/.title` — so sequencing was unreachable even by hand
// and the intro promised something that never happened.
const stateFile = (worker) =>
  `${process.env.TEMP || '/tmp'}/hamilton-packet-${String(worker.phone).replace(/\D/g, '')}.json`;

const saveState = (s) => {
  const f = stateFile(s.worker);
  writeFileSync(f, JSON.stringify(s, null, 2));
  return f;
};

// --- CLI ---------------------------------------------------------------------
// node run-packet.mjs plan    <name> <phone> <en|es>              dry run, prints everything
// node run-packet.mjs start   <name> <phone> <en|es> <rw.json>    really sends doc 1
// node run-packet.mjs advance <phone> <rw.json>                   send next if current is signed
// node run-packet.mjs status  <phone>                             where is this worker
const [, , cmd, a1, a2, a3, a4] = process.argv;

if (cmd === 'plan' || cmd === 'start') {
  const dryRun = cmd === 'plan';
  const worker = { name: a1, phone: a2, language: a3 };
  const p = await startPacket(worker, a4, { dryRun });
  if (p.aborted) { console.log('ABORTED: ' + p.aborted); process.exit(1); }
  console.log(`packet: ${p.total} documents, lang=${p.lang}${dryRun ? '  (DRY RUN)' : ''}`);
  console.log(`\nintro:\n${p.intro}`);
  console.log(`\nfirst document:\n${p.message}`);
  console.log(`\nremaining, sent as each is signed:`);
  const of = p.lang === 'es' ? 'de' : 'of';
  HIRE_PACKET[p.lang].slice(1).forEach((d, i) => console.log(`  ${i + 2} ${of} ${p.total}: ${d.title}`));
  if (!dryRun) console.log(`\nstate: ${saveState(p)}\nnow poll:  node run-packet.mjs advance ${worker.phone} <rw.json>`);
} else if (cmd === 'advance' || cmd === 'status') {
  const f = stateFile({ phone: a1 });
  if (!existsSync(f)) { console.log(`no packet in progress for ${a1} (${f})`); process.exit(1); }
  const state = JSON.parse(readFileSync(f, 'utf8'));
  if (cmd === 'status') {
    const last = state.sent[state.sent.length - 1];
    console.log(`${state.worker.name}: ${state.sent.length} of ${state.total} sent, awaiting "${last.title}"`);
    process.exit(0);
  }
  const r = await advance(state, a2, { dryRun: !a2 });
  console.log(r.action + (r.on ? `: ${r.on}` : ''));
  if (r.message) console.log(r.message);
  saveState(state);
}
