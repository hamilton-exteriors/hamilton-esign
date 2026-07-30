// Orchestrate a worker packet without allowing preview, delivery, worker type, and
// post-training certification to blur into one unsafe operation.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  archiveSubmission,
  createSigningRequest,
  deliverSignedCopy,
  sendWhatsApp,
  templateByName,
  workerLinkForSubmission,
} from './send-signing-link.mjs';
import { sendPamphlets } from './send-pamphlets.mjs';
import { sendPrograms, programStatus } from './send-programs.mjs';
import { packetFor, validate } from './worker-types.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { PACKET_STATE_DIR } from './config.mjs';

const client = createDocusealClient();

// No em or en dashes in anything a worker reads. Plain hyphens, commas and
// colons survive every delivery path and match the owner's voice.
const copy = {
  en: {
    intro: (n) => `You're hired, welcome aboard. There are ${n} documents to sign, about 15 minutes total. ` +
      `I'll send them one at a time so you're never looking at more than one. ` +
      `Questions on any of it, call me at (650) 977-3241.`,
    doc: (i, n, title, link) => `${i} of ${n}: ${title}\n${link}`,
    done: (n) => `That's all ${n} new-hire documents signed. I'll countersign and your copies come back here.`,
    training: (title, link) => `Training is complete. Sign the ${title} attendance record here:\n${link}`,
  },
  es: {
    intro: (n) => `Quedas contratado, bienvenido. Son ${n} documentos para firmar, unos 15 minutos en total. ` +
      `Te los mando de uno en uno para que nunca veas más de uno a la vez. ` +
      `Cualquier duda, llámame al (650) 977-3241.`,
    doc: (i, n, title, link) => `${i} de ${n}: ${title}\n${link}`,
    done: (n) => `Ya están firmados los ${n} documentos de contratación. Yo firmo después y tus copias regresan aquí.`,
    training: (title, link) => `La capacitación terminó. Firma el registro ${title} aquí:\n${link}`,
  },
};

const contractorCopy = {
  en: {
    intro: (n) => `Your contractor onboarding packet is ready. There ${n === 1 ? 'is' : 'are'} ${n} document${n === 1 ? '' : 's'} to review and sign. ` +
      `I will send each one separately. Questions on the agreement, call me at (650) 977-3241.`,
    doc: (i, n, title, link) => `${i} of ${n}: ${title}\n${link}`,
    done: () => `Your portion of the contractor agreement is signed. I will countersign, then your completed copy comes back here.`,
    training: () => { throw new Error('training copy is not valid for an overseas contractor'); },
  },
};

function copyFor(type, language) {
  return type === 'overseas_contractor' ? contractorCopy.en : copy[language];
}

export function packetCopyPreview(type, language, docs, trainingDocument) {
  const text = copyFor(type, language);
  return {
    intro: text.intro(docs.length),
    documents: docs.map((document, index) =>
      text.doc(index + 1, docs.length, document.title, '<private signing link>')),
    completion: text.done(docs.length),
    ...(trainingDocument ? {
      training: text.training(trainingDocument.title, '<private signing link>'),
    } : {}),
  };
}

const NEEDS_HANDOUTS = new Set(['acknowledgment']);
const TRAINING_KEY = 'safety-roster';

async function submission(submissionId) {
  return client.request(`/api/submissions/${submissionId}`, {}, `submission ${submissionId}`);
}

async function isComplete(submissionId) {
  const value = await submission(submissionId);
  const submitters = value.submitters || [];
  return submitters.length > 0 && submitters.every((entry) => entry.completed_at);
}

async function workerDone(submissionId) {
  const value = await submission(submissionId);
  const worker = (value.submitters || []).find((entry) => /worker/i.test(entry.role || ''));
  return Boolean(worker?.completed_at);
}

function resolvePacket(worker) {
  const checked = validate(worker);
  if (!checked.ok) throw new Error(checked.problems.join(' '));
  const packet = packetFor(worker.type, worker.language || 'en');
  const training = packet.docs.find((document) => document.key === TRAINING_KEY) || null;
  const docs = packet.docs.filter((document) => document.key !== TRAINING_KEY);
  if (!docs.length) throw new Error(`no pre-training documents exist for ${worker.type}`);
  return { docs, training, lang: packet.lang };
}

async function preflightPlan(worker, docs, trainingDocument) {
  for (const document of [...docs, ...(trainingDocument ? [trainingDocument] : [])]) {
    await templateByName(document.title);
  }
  const acknowledgment = docs.find((document) => NEEDS_HANDOUTS.has(document.key));
  if (!acknowledgment) return [];
  const status = await programStatus(worker.language === 'es' ? 'es' : 'en');
  const unsigned = status.filter((entry) => !entry.signed);
  return unsigned.length ? [
    `"${acknowledgment.title}" waits until these current safety programs are signed: ` +
    unsigned.map((entry) => entry.title).join('; '),
  ] : [];
}

async function deliveryMessage(plan, pending) {
  const link = await workerLinkForSubmission(
    pending.submissionId,
    plan.lang,
    pending.workerSubmitterId,
  );
  const text = copyFor(plan.type, plan.lang);
  return pending.kind === 'training'
    ? text.training(pending.title, link)
    : text.doc(pending.index + 1, plan.total, pending.title, link);
}

export async function startPacket(worker, rwPath, { dryRun = true, checkpoint = async () => {} } = {}) {
  const resolved = resolvePacket(worker);
  const t = copyFor(worker.type, resolved.lang);
  const plan = {
    packetId: randomUUID(),
    worker: { ...worker, language: resolved.lang },
    type: worker.type,
    lang: resolved.lang,
    docs: resolved.docs,
    trainingDocument: resolved.training,
    total: resolved.docs.length,
    sent: [],
    deliveries: {},
    dryRun,
    phase: 'planned',
    createdAt: new Date().toISOString(),
  };
  plan.intro = t.intro(plan.total);
  plan.blockers = await preflightPlan(plan.worker, plan.docs, plan.trainingDocument);
  plan.message = t.doc(1, plan.total, plan.docs[0].title,
    dryRun ? '<signing link created only by start>' : '<pending>');
  if (dryRun) return plan;

  // Make the packet ID recoverable before the first external side effect. Later
  // checkpoints preserve enough state to resume a created signing request rather
  // than minting a replacement after a process interruption.
  plan.phase = 'starting';
  await checkpoint(plan);
  plan.introAttemptedAt = new Date().toISOString();
  await checkpoint(plan);
  let intro;
  try {
    intro = await sendWhatsApp(worker.phone, plan.intro, rwPath);
  } catch (error) {
    if (error.deliveryAmbiguous) {
      await checkpoint(plan);
      throw new Error(`intro delivery outcome is unknown; inspect WhatsApp before using --retry-ambiguous: ${error.message}`);
    }
    delete plan.introAttemptedAt;
    await checkpoint(plan);
    throw error;
  }
  delete plan.introAttemptedAt;
  plan.phase = 'intro-sent';
  plan.deliveries.intro = { status: intro.status, sentAt: new Date().toISOString() };
  await checkpoint(plan);
  return sendDoc(plan, 0, rwPath, checkpoint);
}

async function deliverRequiredHandouts(plan, rwPath, checkpoint) {
  const key = 'acknowledgment-handouts';
  if (plan.deliveries[key]?.complete) return;
  const current = plan.deliveries[key] || {};
  const pamphlets = await sendPamphlets(plan.worker, rwPath, current.pamphlets);
  plan.deliveries[key] = { ...current, pamphlets: pamphlets.deliveryState };
  await checkpoint(plan);
  if (!pamphlets.sent) throw new Error(`pamphlets not sent: ${pamphlets.reason}`);
  const programs = await sendPrograms(plan.worker, rwPath, current.programs);
  plan.deliveries[key].programs = programs.deliveryState;
  await checkpoint(plan);
  if (!programs.sent) throw new Error(`programs not sent: ${programs.reason}`);
  plan.deliveries[key].complete = true;
  plan.deliveries[key].sentAt = new Date().toISOString();
  await checkpoint(plan);
}

async function sendDoc(plan, index, rwPath, checkpoint = async () => {}, retryAmbiguous = false) {
  const document = plan.docs[index];
  if (!document) throw new Error(`document ${index + 1} is not in packet ${plan.packetId}`);
  if (NEEDS_HANDOUTS.has(document.key)) await deliverRequiredHandouts(plan, rwPath, checkpoint);

  const flags = {
    pamphletsSent: NEEDS_HANDOUTS.has(document.key),
    programsSent: NEEDS_HANDOUTS.has(document.key),
  };
  let pending = plan.pendingDelivery;
  if (pending && (pending.kind !== 'document' || pending.index !== index || pending.key !== document.key)) {
    throw new Error(`packet ${plan.packetId} has a different delivery awaiting recovery`);
  }
  if (!pending) {
    const request = await createSigningRequest(document.title, { ...plan.worker, ...flags }, {
      onboardingId: plan.worker.onboardingId,
      documentKey: document.key,
      classification: plan.type,
      schemaVersion: 1,
    });
    pending = {
      kind: 'document',
      index,
      key: document.key,
      title: request.template,
      submissionId: request.submissionId,
      workerSubmitterId: request.workerSubmitterId,
      createdAt: new Date().toISOString(),
    };
    plan.pendingDelivery = pending;
    await checkpoint(plan);
  }

  if (pending.attemptedAt && !retryAmbiguous) {
    throw new Error(`delivery of ${pending.title} has an unknown outcome; rerun with --retry-ambiguous only after checking WhatsApp`);
  }
  pending.attemptedAt = new Date().toISOString();
  await checkpoint(plan);

  const message = await deliveryMessage(plan, pending);
  let delivered;
  try {
    delivered = await sendWhatsApp(plan.worker.phone, message, rwPath);
  } catch (error) {
    if (error.deliveryAmbiguous) {
      await checkpoint(plan);
      throw new Error(`link delivery outcome is unknown; inspect WhatsApp before using --retry-ambiguous: ${error.message}`);
    }
    await archiveSubmission(pending.submissionId);
    delete plan.pendingDelivery;
    await checkpoint(plan);
    throw new Error(`link delivery failed; replacement submission was revoked: ${error.message}`);
  }

  plan.sent.push({
    i: index + 1,
    key: pending.key,
    title: pending.title,
    submissionId: pending.submissionId,
    workerSubmitterId: pending.workerSubmitterId,
    sentAt: new Date().toISOString(),
    deliveryStatus: delivered.status,
  });
  plan.message = copyFor(plan.type, plan.lang).doc(index + 1, plan.total, pending.title, '<sent privately>');
  plan.phase = 'active';
  delete plan.pendingDelivery;
  await checkpoint(plan);
  return plan;
}

async function deliverCompletedCopies(state, rwPath, dryRun) {
  const ready = [];
  for (const sent of state.sent) {
    if (sent.delivered || !await isComplete(sent.submissionId)) continue;
    ready.push(sent);
    if (!dryRun) {
      const delivered = await deliverSignedCopy(sent.submissionId, state.worker, rwPath);
      if (!delivered.sent) throw new Error(`signed copy ${sent.submissionId} was not delivered`);
      sent.delivered = true;
      sent.deliveredAt = new Date().toISOString();
    }
  }
  return ready;
}

export async function advance(state, rwPath, {
  dryRun = true,
  checkpoint = async () => {},
  retryAmbiguous = false,
} = {}) {
  if (state.pendingDelivery?.kind === 'document') {
    const pending = state.pendingDelivery;
    if (pending.attemptedAt && !retryAmbiguous) {
      return {
        action: 'delivery-ambiguous',
        reason: `${pending.title} may already be in WhatsApp; inspect the conversation before using --retry-ambiguous`,
        state,
        completedCopies: [],
      };
    }
    if (dryRun) {
      return {
        action: 'would-resume-delivery',
        message: copyFor(state.type, state.lang).doc(pending.index + 1, state.total, pending.title, '<private signing link>'),
        state,
        completedCopies: [],
      };
    }
    await sendDoc(state, pending.index, rwPath, checkpoint, retryAmbiguous);
    return { action: 'resumed-delivery', message: state.message, state, completedCopies: [] };
  }

  const completedCopies = await deliverCompletedCopies(state, rwPath, dryRun);
  const last = state.sent[state.sent.length - 1];
  if (!last) {
    if (state.introAttemptedAt && !state.deliveries.intro && !retryAmbiguous) {
      return {
        action: 'delivery-ambiguous',
        reason: 'the intro may already be in WhatsApp; inspect the conversation before using --retry-ambiguous',
        state,
        completedCopies,
      };
    }
    if (dryRun) {
      return {
        action: 'would-send-first',
        message: copyFor(state.type, state.lang).doc(1, state.total, state.docs[0].title, '<signing link>'),
        state,
        completedCopies,
      };
    }
    if (!state.deliveries.intro) {
      state.introAttemptedAt = new Date().toISOString();
      await checkpoint(state);
      let intro;
      try {
        intro = await sendWhatsApp(state.worker.phone, state.intro, rwPath);
      } catch (error) {
        if (error.deliveryAmbiguous) {
          await checkpoint(state);
          throw new Error(`intro delivery outcome is unknown; inspect WhatsApp before using --retry-ambiguous: ${error.message}`);
        }
        delete state.introAttemptedAt;
        await checkpoint(state);
        throw error;
      }
      delete state.introAttemptedAt;
      state.phase = 'intro-sent';
      state.deliveries.intro = { status: intro.status, sentAt: new Date().toISOString() };
      await checkpoint(state);
    }
    await sendDoc(state, 0, rwPath, checkpoint);
    return { action: 'sent-first', message: state.message, state, completedCopies };
  }
  if (!await workerDone(last.submissionId)) {
    return { action: 'wait', on: `${last.i} of ${state.total}: ${last.title}`, completedCopies };
  }

  const nextIndex = state.sent.filter((entry) => entry.key !== TRAINING_KEY).length;
  if (nextIndex >= state.docs.length) {
    const message = copyFor(state.type, state.lang).done(state.total);
    if (!state.deliveries.packetComplete && state.packetCompleteAttemptedAt && !retryAmbiguous) {
      return {
        action: 'delivery-ambiguous',
        reason: 'the completion message may already be in WhatsApp; inspect the conversation before using --retry-ambiguous',
        state,
        completedCopies,
      };
    }
    if (!dryRun && !state.deliveries.packetComplete) {
      state.packetCompleteAttemptedAt = new Date().toISOString();
      await checkpoint(state);
      let result;
      try {
        result = await sendWhatsApp(state.worker.phone, message, rwPath);
      } catch (error) {
        if (error.deliveryAmbiguous) {
          await checkpoint(state);
          throw new Error(`completion-message delivery outcome is unknown; inspect WhatsApp before using --retry-ambiguous: ${error.message}`);
        }
        delete state.packetCompleteAttemptedAt;
        await checkpoint(state);
        throw error;
      }
      delete state.packetCompleteAttemptedAt;
      state.deliveries.packetComplete = { status: result.status, sentAt: new Date().toISOString() };
      await checkpoint(state);
    }
    return { action: 'packet-complete', message, state, completedCopies };
  }

  if (dryRun) {
    const document = state.docs[nextIndex];
    return {
      action: 'would-send-next',
      message: copyFor(state.type, state.lang).doc(nextIndex + 1, state.total, document.title, '<signing link>'),
      state,
      completedCopies,
    };
  }
  await sendDoc(state, nextIndex, rwPath, checkpoint);
  return { action: 'sent-next', message: state.message, state, completedCopies };
}

function validateTrainingEvidence(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('training evidence JSON is required, not only a trainer name');
  }
  const required = ['trainer', 'completedAt', 'topicsVersion', 'attendanceEvidenceRef'];
  const missing = required.filter((key) => !String(value[key] || '').trim());
  if (missing.length) throw new Error(`training evidence is missing: ${missing.join(', ')}`);
  if (value.operatorAttested !== true) {
    throw new Error('training evidence requires operatorAttested=true after actual instruction');
  }
  if (/https?:\/\/\S+\/s\/\S+/i.test(value.attendanceEvidenceRef)) {
    throw new Error('training evidence cannot contain a private signing URL');
  }
  return {
    trainer: String(value.trainer).trim(),
    completedAt: String(value.completedAt).trim(),
    topicsVersion: String(value.topicsVersion).trim(),
    attendanceEvidenceRef: String(value.attendanceEvidenceRef).trim(),
    operatorAttested: true,
  };
}

export async function sendTrainingRoster(state, trainingEvidence, rwPath, {
  checkpoint = async () => {},
  retryAmbiguous = false,
} = {}) {
  const evidence = validateTrainingEvidence(trainingEvidence);
  if (!state.trainingDocument) throw new Error(`worker type ${state.type} has no training roster`);
  if (state.sent.some((entry) => entry.key === TRAINING_KEY)) {
    throw new Error('training roster has already been sent for this packet');
  }
  if (state.sent.filter((entry) => entry.key !== TRAINING_KEY).length !== state.docs.length) {
    throw new Error('all pre-training packet documents must be sent first');
  }
  const last = state.sent[state.sent.length - 1];
  if (!last || !await workerDone(last.submissionId)) {
    throw new Error('the worker must finish the pre-training packet before the roster is sent');
  }

  let pending = state.pendingDelivery;
  if (pending && pending.kind !== 'training') {
    throw new Error(`packet ${state.packetId} has a different delivery awaiting recovery`);
  }
  if (pending && pending.trainingEvidence.trainer !== evidence.trainer) {
    throw new Error(`training roster is already awaiting delivery for trainer ${pending.trainingEvidence.trainer}`);
  }
  if (!pending) {
    const request = await createSigningRequest(state.trainingDocument.title, state.worker, {
      onboardingId: state.worker.onboardingId,
      documentKey: state.trainingDocument.key,
      classification: state.type,
      schemaVersion: 1,
    });
    pending = {
      kind: 'training',
      trainingEvidence: evidence,
      title: request.template,
      submissionId: request.submissionId,
      workerSubmitterId: request.workerSubmitterId,
      createdAt: new Date().toISOString(),
    };
    state.pendingDelivery = pending;
    await checkpoint(state);
  }

  if (pending.attemptedAt && !retryAmbiguous) {
    throw new Error(`training roster delivery has an unknown outcome; inspect WhatsApp before using --retry-ambiguous`);
  }
  pending.attemptedAt = new Date().toISOString();
  await checkpoint(state);
  const message = await deliveryMessage(state, pending);
  let delivered;
  try {
    delivered = await sendWhatsApp(state.worker.phone, message, rwPath);
  } catch (error) {
    if (error.deliveryAmbiguous) {
      await checkpoint(state);
      throw new Error(`training roster delivery outcome is unknown; inspect WhatsApp before using --retry-ambiguous: ${error.message}`);
    }
    await archiveSubmission(pending.submissionId);
    delete state.pendingDelivery;
    await checkpoint(state);
    throw new Error(`training roster delivery failed; submission was revoked: ${error.message}`);
  }

  state.training = { ...pending.trainingEvidence, recordedAt: new Date().toISOString() };
  state.sent.push({
    i: state.total + 1,
    key: TRAINING_KEY,
    title: pending.title,
    submissionId: pending.submissionId,
    workerSubmitterId: pending.workerSubmitterId,
    sentAt: new Date().toISOString(),
    deliveryStatus: delivered.status,
  });
  state.message = copyFor(state.type, state.lang).training(pending.title, '<sent privately>');
  delete state.pendingDelivery;
  await checkpoint(state);
  return { action: 'training-roster-sent', message: state.message, state };
}

function ensureStateDir() {
  mkdirSync(PACKET_STATE_DIR, { recursive: true });
}
const stateFile = (packetId) => join(PACKET_STATE_DIR, `${packetId}.json`);
const lockFile = (packetId) => join(PACKET_STATE_DIR, `${packetId}.lock`);

export function loadState(packetId) {
  const path = stateFile(packetId);
  if (!existsSync(path)) throw new Error(`no packet state found for ${packetId}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stateForPersistence(state) {
  const safe = structuredClone(state);
  const scrub = (value) => {
    if (Array.isArray(value)) {
      value.forEach(scrub);
      return;
    }
    if (!value || typeof value !== 'object') return;
    delete value.link;
    delete value.slug;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /https?:\/\/\S+\/s\/\S+/i.test(child)) {
        value[key] = child.replace(/https?:\/\/\S+\/s\/\S+/ig, '<private signing link>');
      } else {
        scrub(child);
      }
    }
  };
  scrub(safe);
  return safe;
}

export function saveState(state) {
  ensureStateDir();
  const path = stateFile(state.packetId);
  const temporary = `${path}.${process.pid}.tmp`;
  const safe = stateForPersistence(state);
  writeFileSync(temporary, JSON.stringify(safe, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function staleLock(path) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Pre-hardening locks were empty. Reclaim only after a conservative delay so
    // a second process cannot mistake the tiny create/write window for a crash.
    try { return Date.now() - statSync(path).mtimeMs > 6 * 60 * 60 * 1000; }
    catch { return false; }
  }
  if (!Number.isInteger(owner.pid) || !owner.startedAt) {
    try { return Date.now() - statSync(path).mtimeMs > 6 * 60 * 60 * 1000; }
    catch { return false; }
  }
  return !processIsRunning(owner.pid);
}

export async function withLock(packetId, operation) {
  ensureStateDir();
  const path = lockFile(packetId);
  const token = randomUUID();
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try { unlinkSync(path); }
        catch { /* The original lock-creation error is more useful. */ }
      }
      descriptor = undefined;
      if (error.code === 'EEXIST' && attempt === 0 && staleLock(path)) {
        unlinkSync(path);
        continue;
      }
      if (error.code === 'EEXIST') throw new Error(`packet ${packetId} is already being advanced`);
      throw error;
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    let owner = null;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); }
    catch { /* Do not remove a lock whose ownership cannot be proved. */ }
    if (owner?.token === token) unlinkSync(path);
  }
}

function usage() {
  console.error('usage:');
  console.error('  new plans and starts require pipeline/onboarding.mjs');
  console.error('  node run-packet.mjs advance <packetId> [rw.json] [--retry-ambiguous]');
  console.error('  node run-packet.mjs status <packetId>');
  console.error('  node run-packet.mjs training <packetId> <training-evidence.json> <rw.json> [--retry-ambiguous]');
}

const IS_MAIN = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (IS_MAIN) {
  const [, , command, ...args] = process.argv;
  try {
    if (command === 'start' || command === 'plan') {
      throw new Error('direct packet planning and start are disabled; use pipeline/onboarding.mjs so structured intake, copy approval, and lifecycle gates are enforced');
    }
    if (command === 'advance') {
      const [packetId, rwPath, retryFlag] = args;
      if (!packetId || rwPath === '--retry-ambiguous' ||
        (retryFlag && retryFlag !== '--retry-ambiguous')) {
        usage(); process.exit(1);
      }
      await withLock(packetId, async () => {
        const state = loadState(packetId);
        try {
          const result = await advance(state, rwPath, {
            dryRun: !rwPath,
            checkpoint: async () => saveState(state),
            retryAmbiguous: retryFlag === '--retry-ambiguous',
          });
          console.log(result.action + (result.on ? `: ${result.on}` : ''));
          if (result.reason) console.log(result.reason);
          if (result.message) console.log(result.message);
        } finally {
          // Preserve confirmed per-item delivery progress even when a later send
          // fails, so a retry does not resend successful handouts.
          if (rwPath) saveState(state);
        }
      });
    } else if (command === 'status') {
      const [packetId] = args;
      if (!packetId) { usage(); process.exit(1); }
      const state = loadState(packetId);
      const last = state.sent[state.sent.length - 1];
      console.log(`${state.worker.name}: ${state.sent.length} sent${last ? `, latest "${last.title}"` : ''}`);
    } else if (command === 'training') {
      const [packetId, evidencePath, rwPath, retryFlag] = args;
      if (!packetId || !evidencePath || !rwPath ||
        (retryFlag && retryFlag !== '--retry-ambiguous')) {
        usage(); process.exit(1);
      }
      const trainingEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      await withLock(packetId, async () => {
        const state = loadState(packetId);
        const result = await sendTrainingRoster(state, trainingEvidence, rwPath, {
          checkpoint: async () => saveState(state),
          retryAmbiguous: retryFlag === '--retry-ambiguous',
        });
        console.log(result.action);
      });
    } else {
      usage();
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
