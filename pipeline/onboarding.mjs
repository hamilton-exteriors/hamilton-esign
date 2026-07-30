import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  approveCopy,
  createRecord,
  deriveStatus,
  loadRecord,
  recordGate,
  rebindOverseasRole,
  saveRecord,
  withRecordLock,
} from './onboarding-state.mjs';
import {
  advance as advancePacket,
  loadState as loadPacket,
  packetCopyPreview,
  saveState as savePacket,
  sendTrainingRoster,
  startPacket,
  withLock as withPacketLock,
} from './run-packet.mjs';
import { countersignLink, signedCopyCaption } from './send-signing-link.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { fileSubmission } from './file-to-drive.mjs';
import { pamphletCopy } from './send-pamphlets.mjs';
import { programCopy } from './send-programs.mjs';
import { REFERENCES_DIR } from './config.mjs';
import { resolveRoleBinding } from './role-catalog.mjs';
import { createPlatformOnboardingClient, platformCutoverEnabled } from './platform-client.mjs';

const client = createDocusealClient();

function actor() {
  return process.env.HAMILTON_OPERATOR || process.env.USERNAME || process.env.USER || 'operator';
}

function readJson(path, label) {
  if (!path) throw new Error(`${label} JSON path is required`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} JSON: ${error.message}`);
  }
}

export function buildRoleReleasePayload(metadata, artifactContent) {
  const allowed = ['roleKey', 'displayName', 'releaseVersion', 'artifactReference', 'approvalReference', 'approvedByName', 'approvedAt'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some((key) => !allowed.includes(key)) || allowed.some((key) => typeof metadata[key] !== 'string' || !metadata[key])) {
    throw new Error('role release metadata is malformed or incomplete');
  }
  if (typeof artifactContent !== 'string' || !artifactContent || Buffer.byteLength(artifactContent, 'utf8') > 256 * 1024) throw new Error('role release artifact is empty or too large');
  return {
    ...Object.fromEntries(allowed.map((key) => [key, metadata[key]])),
    artifactContent,
    artifactDigest: createHash('sha256').update(Buffer.from(artifactContent, 'utf8')).digest('hex'),
  };
}

function referenceArtifact(name, caption) {
  const path = resolve(REFERENCES_DIR, name);
  const bytes = readFileSync(path);
  return {
    name,
    caption,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function contractorRoleScopeRelease(record) {
  if (record.type !== 'overseas_contractor') return null;
  return resolveRoleBinding(record.roleBinding);
}

export function hashCopyBundle(copyBundle) {
  return createHash('sha256').update(JSON.stringify(copyBundle)).digest('hex');
}

function packetWorker(record) {
  const intake = record.intake;
  return {
    onboardingId: record.onboardingId,
    type: record.type,
    name: intake.name,
    phone: intake.phone,
    language: intake.language,
    email: intake.email,
    role: intake.role,
    roleKey: intake.roleKey,
    roleExpectationsVersion: intake.roleExpectationsVersion,
    startDate: intake.startDate,
    country: intake.country,
    rateProbation: intake.rateProbation,
    probationMonths: intake.probationMonths,
    rate: intake.rate,
  };
}

export function contractorPreSendGateBlockers(record) {
  if (record.type !== 'overseas_contractor') return [];
  const required = ['role_scope_approved', 'w8ben_instructions_delivered',
    'role_expectations_delivered', 'payment_rail_verified'];
  return required.filter((name) => record.gates[name]?.status !== 'satisfied');
}

export function contractorStartGate(record) {
  if (record.type !== 'overseas_contractor') return;
  const roleScopeRelease = contractorRoleScopeRelease(record);
  if (!roleScopeRelease.approved) {
    throw new Error(`contractor agreement remains blocked until ${roleScopeRelease.displayName} scope version ${roleScopeRelease.version} is owner-approved for release`);
  }
  const pending = contractorPreSendGateBlockers(record);
  if (pending.length) {
    throw new Error(`contractor agreement remains blocked until these pre-send gates are evidenced: ${pending.join(', ')}`);
  }
}

export function wageNoticeBlockers(record, nextDocument) {
  if (record.type !== 'w2_local' || nextDocument?.key !== 'wage-notice') return [];
  return ['wc_5552_bound', 'wage_notice_wc_fields_verified']
    .filter((name) => record.gates[name]?.status !== 'satisfied');
}

async function synchronize(record, packet) {
  const previous = new Map(record.documents.map((document) => [document.submissionId, document]));
  const documents = [];
  for (const sent of packet.sent || []) {
    const submission = await client.request(`/api/submissions/${sent.submissionId}`, {},
      `submission ${sent.submissionId}`);
    const submitters = submission.submitters || [];
    const worker = submitters.find((entry) => /worker/i.test(entry.role || '')) || submitters[0];
    const hamilton = submitters.find((entry) => /hamilton/i.test(entry.role || ''));
    const prior = previous.get(sent.submissionId) || {};
    documents.push({
      key: sent.key,
      templateName: sent.title,
      submissionId: sent.submissionId,
      requiresCountersign: Boolean(hamilton),
      ...(worker?.completed_at ? { workerSignedAt: worker.completed_at } : {}),
      ...(hamilton?.completed_at ? { countersignedAt: hamilton.completed_at } : {}),
      ...(sent.deliveredAt ? { copyDeliveredAt: sent.deliveredAt } : {}),
      ...(prior.filedAt ? { filedAt: prior.filedAt } : {}),
      ...(prior.driveFileIds ? { driveFileIds: prior.driveFileIds } : {}),
    });
  }
  record.documents = documents;
  const waitingWorker = documents.some((document) => !document.workerSignedAt);
  const waitingCountersign = documents.some((document) =>
    document.workerSignedAt && document.requiresCountersign && !document.countersignedAt);
  const waitingCopy = documents.some((document) =>
    document.workerSignedAt && (!document.requiresCountersign || document.countersignedAt) && !document.copyDeliveredAt);
  const waitingFiling = documents.some((document) =>
    document.workerSignedAt && (!document.requiresCountersign || document.countersignedAt) && !document.filedAt);
  if (packet.pendingDelivery || waitingWorker || documents.length < packet.docs.length) {
    record.phase = 'awaiting_worker_signature';
  } else if (waitingCountersign) {
    record.phase = 'awaiting_countersignature';
  } else if (waitingCopy) {
    record.phase = 'awaiting_executed_copy_delivery';
  } else if (waitingFiling) {
    record.phase = 'awaiting_filing';
  } else {
    record.phase = 'awaiting_manual_gates';
  }
  record.updatedAt = new Date().toISOString();
  const status = deriveStatus(record);
  if (status.complete) record.phase = 'complete';
  return record;
}

function openPrivateUrl(value) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', value];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [value];
  } else {
    command = 'xdg-open';
    args = [value];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function create(type, intakePath) {
  const intake = readJson(intakePath, 'intake');
  if (platformCutoverEnabled()) {
    // Platform owns new production state after cutover. Validate and normalize
    // locally first so catalog defaults and numeric coercion remain identical.
    const normalized = validateIntakeForPlatform(type, intake);
    return { record: await createPlatformOnboardingClient().create(type, normalized), path: null };
  }
  const record = createRecord(type, intake);
  const path = saveRecord(record);
  return { record, path };
}

function validateIntakeForPlatform(type, intake) {
  // createRecord validates existing intake and catalog rules in memory; project
  // only the strict Platform retry snapshot so unknown/local-only keys never cross.
  const normalized = createRecord(type, intake, { id: 'validation-only' }).intake;
  const common = {
    name: normalized.name,
    phone: normalized.phone,
    ...(normalized.email ? { email: normalized.email } : {}),
    startDate: normalized.startDate,
    role: normalized.role,
    language: normalized.language,
  };
  return type === 'w2_local'
    ? {
      ...common,
      baseHourlyRate: normalized.baseHourlyRate,
      productionBonusRate: normalized.productionBonusRate,
      sickLeaveMethod: normalized.sickLeaveMethod,
      payday: normalized.payday,
    }
    : {
      ...common,
      roleKey: normalized.roleKey,
      roleExpectationsVersion: normalized.roleExpectationsVersion,
      country: normalized.country,
      rateProbation: normalized.rateProbation,
      probationMonths: normalized.probationMonths,
      rate: normalized.rate,
      currency: normalized.currency,
      cadence: normalized.cadence,
      paymentRail: normalized.paymentRail,
    };
}

function platformClient() {
  return createPlatformOnboardingClient();
}

async function plan(record) {
  const packet = await startPacket(packetWorker(record), undefined, { dryRun: true });
  const blockers = [...packet.blockers];
  const roleScope = record.type === 'overseas_contractor'
    ? contractorRoleScopeRelease(record)
    : null;
  if (record.type === 'w2_local') {
    if (record.gates.wc_5552_bound.status !== 'satisfied') {
      blockers.push('WC class 5552 is not evidenced; the wage notice and all roof-work release remain blocked');
    }
    if (record.gates.wage_notice_wc_fields_verified.status !== 'satisfied') {
      blockers.push('the live wage notice carrier and policy fields are not verified populated');
    }
  }
  if (record.type === 'overseas_contractor') {
    if (!roleScope.approved) {
      blockers.push(`${roleScope.displayName} scope version ${roleScope.version} is not owner-approved for release`);
    }
    for (const name of ['role_scope_approved', 'w8ben_instructions_delivered',
      'role_expectations_delivered', 'payment_rail_verified']) {
      if (record.gates[name].status !== 'satisfied') blockers.push(`pre-send evidence required: ${name}`);
    }
  }
  const copyBundle = {
    packet: packetCopyPreview(record.type, packet.lang, packet.docs, packet.trainingDocument),
    executedCopy: signedCopyCaption(packet.lang),
    ...(record.type === 'w2_local' ? {
      pamphlets: pamphletCopy(packet.lang),
      safetyPrograms: programCopy(packet.lang),
    } : {
      manualArtifacts: {
        intro: 'Before you sign the agreement, review these two onboarding documents.',
        documents: [
          referenceArtifact(
            'w8ben-instructions-return-procedure.md',
            'W-8BEN instructions and secure return procedure',
          ),
          {
            name: roleScope.artifact,
            caption: `${roleScope.displayName} role scope, version ${roleScope.version}`,
            roleKey: roleScope.roleKey,
            version: roleScope.version,
            sha256: roleScope.sha256,
          },
        ],
      },
    }),
  };
  const copyHash = hashCopyBundle(copyBundle);
  return {
    onboardingId: record.onboardingId,
    type: record.type,
    ...(roleScope ? { role: {
      roleKey: roleScope.roleKey,
      displayName: roleScope.displayName,
      version: roleScope.version,
      active: roleScope.active,
      approved: roleScope.approved,
    } } : {}),
    phase: record.phase,
    documents: packet.docs.map((document) => document.title),
    trainingDocument: packet.trainingDocument?.title || null,
    blockers,
    copyBundle,
    copyHash,
    manualGates: Object.keys(record.gates),
    prohibited: record.type === 'w2_local'
      ? ['W-9', '1099', 'Mercury recipient', 'vendor bill', 'independent contractor agreement']
      : ['I-9', 'W-4', 'DE 4', 'DE 34', 'California pamphlets', 'workers compensation', 'payroll'],
  };
}

export function assertCopyHash(record, currentHash) {
  if (!record.copyApproval?.copyHash) throw new Error('exact outbound copy has not been approved');
  if (record.copyApproval.copyHash !== currentHash) {
    throw new Error('approved copy no longer matches the current plan; review and approve the new copy hash');
  }
}

export async function assertApprovedCopy(record) {
  const currentPlan = await plan(record);
  assertCopyHash(record, currentPlan.copyHash);
}

async function start(record, rwPath) {
  if (record.phase !== 'ready_to_send') throw new Error('exact outbound copy must be approved before start');
  await assertApprovedCopy(record);
  contractorStartGate(record);
  let packet;
  packet = await startPacket(packetWorker(record), rwPath, {
    dryRun: false,
    checkpoint: async (current) => savePacket(current),
  });
  record.packetId = packet.packetId;
  record.phase = 'packet_active';
  record.audit.push({
    at: new Date().toISOString(),
    actor: actor(),
    action: 'packet-started',
    details: { packetId: packet.packetId },
  });
  await synchronize(record, packet);
  saveRecord(record);
  return { record, packet };
}

async function advance(record, rwPath, retryAmbiguous) {
  if (!record.packetId) throw new Error('onboarding packet has not been started');
  if (rwPath) await assertApprovedCopy(record);
  return withPacketLock(record.packetId, async () => {
    const packet = loadPacket(record.packetId);
    const nextDocument = packet.docs?.[packet.sent?.length];
    const missing = wageNoticeBlockers(record, nextDocument);
    if (missing.length) {
      record.phase = 'awaiting_manual_gates';
      saveRecord(record);
      return {
        result: {
          action: 'blocked-wc-5552',
          reason: `the wage notice remains blocked until these gates are evidenced: ${missing.join(', ')}`,
        },
        record,
      };
    }
    const result = await advancePacket(packet, rwPath, {
      dryRun: !rwPath,
      checkpoint: async () => savePacket(packet),
      retryAmbiguous,
    });
    if (rwPath) savePacket(packet);
    await synchronize(record, packet);
    saveRecord(record);
    return { result, record };
  });
}

async function training(record, evidencePath, rwPath, retryAmbiguous) {
  if (record.type !== 'w2_local') throw new Error('training roster is only valid for w2_local');
  if (!record.packetId) throw new Error('onboarding packet has not been started');
  await assertApprovedCopy(record);
  const evidence = readJson(evidencePath, 'training evidence');
  return withPacketLock(record.packetId, async () => {
    const packet = loadPacket(record.packetId);
    const result = await sendTrainingRoster(packet, evidence, rwPath, {
      checkpoint: async () => savePacket(packet),
      retryAmbiguous,
    });
    savePacket(packet);
    await synchronize(record, packet);
    saveRecord(record);
    return result;
  });
}

async function countersign(record, open) {
  if (platformCutoverEnabled()) {
    const api = platformClient();
    const status = await api.status(record);
    const ref = status.countersignReady?.[0]?.submissionRef;
    if (typeof ref !== 'string' || !/^docuseal:\d+$/.test(ref)) throw new Error('no countersign action is ready');
    if (!open) return { ready: status.countersignReady.length, action: 'rerun with --open after confirming the authorized Hamilton operator is present' };
    // The route is retrieved from DocuSeal only after explicit --open and is kept in memory.
    const result = await countersignLink(ref.slice('docuseal:'.length));
    if (!result.ready) throw new Error('DocuSeal countersign action is no longer ready');
    openPrivateUrl(result.link);
    await api.auditCountersignOpen(record, ref);
    return { ready: status.countersignReady.length, opened: 'countersign action' };
  }
  if (!record.packetId) throw new Error('onboarding packet has not been started');
  const packet = loadPacket(record.packetId);
  await synchronize(record, packet);
  const ready = [];
  for (const document of record.documents) {
    if (!document.workerSignedAt || document.countersignedAt || !document.requiresCountersign) continue;
    const result = await countersignLink(document.submissionId);
    if (result.ready) ready.push({ document, result });
  }
  if (!ready.length) throw new Error('no countersign action is ready');
  if (!open) {
    return { ready: ready.length, action: 'rerun with --open after confirming the authorized Hamilton operator is present' };
  }
  openPrivateUrl(ready[0].result.link);
  record.audit.push({
    at: new Date().toISOString(),
    actor: actor(),
    action: 'countersign-opened',
    details: { submissionId: ready[0].document.submissionId },
  });
  saveRecord(record);
  return { ready: ready.length, opened: ready[0].document.templateName };
}

async function file(record) {
  if (!record.packetId) throw new Error('onboarding packet has not been started');
  const packet = loadPacket(record.packetId);
  await synchronize(record, packet);
  const filed = [];
  for (const document of record.documents) {
    if (!document.workerSignedAt || (document.requiresCountersign && !document.countersignedAt)) continue;
    const results = await fileSubmission(document.submissionId);
    document.filedAt = new Date().toISOString();
    document.driveFileIds = results.map((result) => result.fileId).filter(Boolean);
    filed.push({ templateName: document.templateName, files: document.driveFileIds.length });
  }
  await synchronize(record, packet);
  saveRecord(record);
  return filed;
}

function usage() {
  console.error('usage:');
  console.error('  node pipeline/onboarding.mjs create <w2_local|overseas_contractor> <intake.json>');
  if (platformCutoverEnabled()) {
    console.error('  node pipeline/onboarding.mjs publish-role-release <release-metadata.json> <approved-role-artifact.md>');
    console.error('  node pipeline/onboarding.mjs plan <onboardingId> [initial|training]');
    console.error('  node pipeline/onboarding.mjs rebind-role <onboardingId> <role-key> <version>');
    console.error('  node pipeline/onboarding.mjs approve-copy <onboardingId> <plan-id> <initial|training> <copy-hash> <approval-reference>');
    console.error('  node pipeline/onboarding.mjs start <onboardingId> <plan-id> <initial|training> <digest>');
    console.error('  node pipeline/onboarding.mjs reconcile <onboardingId>');
    console.error('  node pipeline/onboarding.mjs resolve-effect <onboardingId> <idempotency-key> <succeeded|definite_failed> <evidence-reference> [success-proof.json]');
  } else {
    console.error('  node pipeline/onboarding.mjs plan <onboardingId>');
    console.error('  node pipeline/onboarding.mjs rebind-role <onboardingId> <role-key> [version]');
    console.error('  node pipeline/onboarding.mjs approve-copy <onboardingId> <copy-hash> <approval-reference>');
    console.error('  node pipeline/onboarding.mjs start <onboardingId> <rw.json>');
    console.error('  node pipeline/onboarding.mjs advance <onboardingId> [rw.json] [--retry-ambiguous]');
    console.error('  node pipeline/onboarding.mjs training <onboardingId> <training-evidence.json> <rw.json> [--retry-ambiguous]');
    console.error('  node pipeline/onboarding.mjs file <onboardingId>');
  }
  console.error('  node pipeline/onboarding.mjs countersign <onboardingId> [--open]');
  console.error('  node pipeline/onboarding.mjs record-gate <onboardingId> <gate> <evidence-reference>');
  console.error('  node pipeline/onboarding.mjs import-legacy <state.json> [--apply]');
  console.error('  node pipeline/onboarding.mjs status <onboardingId>');
}

const IS_MAIN = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (IS_MAIN) {
  const [, , command, ...args] = process.argv;
  try {
    if (command === 'import-legacy') {
      const [statePath, apply] = args;
      if (!statePath || (apply && apply !== '--apply')) throw new Error('import-legacy requires a state JSON path and optional --apply');
      const legacy = readJson(statePath, 'legacy state');
      // Do not mutate the source file. Platform validates the complete import and
      // defaults to dry-run; --apply is explicit and remains non-destructive here.
      const output = await platformClient().importLegacy(legacy, { dryRun: apply !== '--apply' });
      console.log(JSON.stringify(output, null, 2));
    } else if (platformCutoverEnabled() && command === 'publish-role-release') {
      const [metadataPath, artifactPath, extra] = args;
      if (!metadataPath || !artifactPath || extra) throw new Error('publish-role-release requires metadata JSON and one approved role artifact path');
      const metadata = readJson(metadataPath, 'role release metadata');
      const artifactContent = readFileSync(artifactPath, 'utf8');
      const output = await platformClient().publishRoleRelease(buildRoleReleasePayload(metadata, artifactContent));
      console.log(JSON.stringify(output, null, 2));
    } else if (platformCutoverEnabled() && command === 'create') {
      const [type, intakePath] = args;
      if (!type || !intakePath) throw new Error('create requires worker classification and intake JSON path');
      const { record } = await create(type, intakePath);
      console.log(JSON.stringify(record, null, 2));
    } else if (platformCutoverEnabled() && ['advance', 'training', 'file'].includes(command)) {
      throw new Error(`${command} is automatic after Platform cutover; use status or reconcile instead`);
    } else if (platformCutoverEnabled() && ['plan', 'approve-copy', 'record-gate', 'rebind-role', 'start', 'status', 'reconcile', 'resolve-effect'].includes(command)) {
      const api = platformClient();
      const [id, first, second, third, fourth] = args;
      if (!id) throw new Error(`${command} requires onboarding ID`);
      let output;
      if (command === 'plan') output = await api.plan(id, first || 'initial');
      else if (command === 'status') output = await api.status(id);
      else if (command === 'start') {
        if (!first || !second || !third) throw new Error('start requires ID, plan ID, stage, and digest');
        output = await api.start(id, first, second, third);
      } else if (command === 'reconcile') output = await api.reconcile(id);
      else if (command === 'resolve-effect') {
        if (!first || !['succeeded', 'definite_failed'].includes(second) || !third) {
          throw new Error('resolve-effect requires ID, idempotency key, succeeded|definite_failed, evidence reference, and a success-proof JSON file for succeeded');
        }
        if (second === 'succeeded' && !fourth) throw new Error('successful effect resolution requires a success-proof JSON file');
        if (second === 'definite_failed' && fourth) throw new Error('definite-failed effect resolution does not accept success proof');
        output = await api.resolveEffect(id, first, second, third, fourth ? readJson(fourth, 'effect success proof') : undefined);
      } else if (command === 'approve-copy') {
        if (!first || !second || !third || !fourth) throw new Error('approve-copy requires ID, plan ID, stage, copy hash, and approval reference');
        output = await api.approveCopy(id, first, second, third, fourth);
      } else if (command === 'rebind-role') {
        if (!first || !second) throw new Error('rebind-role requires ID, role key, and release version');
        output = await api.rebindRole(id, first, second);
      } else {
        if (!first || !second) throw new Error('record-gate requires ID, gate, and evidence reference');
        output = await api.recordGate(id, first, second);
      }
      console.log(JSON.stringify(output, null, 2));
    } else if (command === 'create') {
      const [type, intakePath] = args;
      const { record, path } = await create(type, intakePath);
      console.log(JSON.stringify({ onboardingId: record.onboardingId, type: record.type,
        phase: record.phase, state: path }, null, 2));
    } else if (command === 'plan') {
      console.log(JSON.stringify(await plan(loadRecord(args[0])), null, 2));
    } else if (command === 'rebind-role') {
      const [id, role, version] = args;
      if (!id || !role) throw new Error('rebind-role requires onboarding ID and role key or exact display name');
      const rebound = await withRecordLock(id, async () => {
        const record = rebindOverseasRole(loadRecord(id), role, version, { actor: actor() });
        saveRecord(record);
        return record;
      });
      console.log(JSON.stringify({
        onboardingId: rebound.onboardingId,
        role: rebound.roleBinding,
        status: deriveStatus(rebound),
        next: `node pipeline/onboarding.mjs plan ${rebound.onboardingId}`,
      }, null, 2));
    } else if (command === 'approve-copy') {
      const [id, copyHash, reference] = args;
      if (!id || !copyHash || !reference) throw new Error('approve-copy requires ID, copy hash, and approval reference');
      await withRecordLock(id, async () => {
        const record = loadRecord(id);
        const currentPlan = await plan(record);
        if (copyHash !== currentPlan.copyHash) throw new Error('copy hash does not match the current plan');
        saveRecord(approveCopy(record, reference, copyHash, actor()));
      });
      console.log(JSON.stringify(deriveStatus(loadRecord(id)), null, 2));
    } else if (command === 'start') {
      const [id, rwPath] = args;
      if (!id || !rwPath) throw new Error('start requires onboarding ID and rw.json');
      await withRecordLock(id, async () => start(loadRecord(id), rwPath));
      console.log(JSON.stringify(deriveStatus(loadRecord(id)), null, 2));
    } else if (command === 'advance') {
      const [id, rwPath, retryFlag] = args;
      if (!id || rwPath === '--retry-ambiguous' ||
        (retryFlag && retryFlag !== '--retry-ambiguous')) throw new Error('invalid advance arguments');
      const output = await withRecordLock(id, async () =>
        advance(loadRecord(id), rwPath, retryFlag === '--retry-ambiguous'));
      console.log(JSON.stringify({ action: output.result.action, status: deriveStatus(output.record) }, null, 2));
    } else if (command === 'training') {
      const [id, evidencePath, rwPath, retryFlag] = args;
      if (!id || !evidencePath || !rwPath ||
        (retryFlag && retryFlag !== '--retry-ambiguous')) throw new Error('invalid training arguments');
      const output = await withRecordLock(id, async () =>
        training(loadRecord(id), evidencePath, rwPath, retryFlag === '--retry-ambiguous'));
      console.log(JSON.stringify({ action: output.action, status: deriveStatus(loadRecord(id)) }, null, 2));
    } else if (command === 'countersign') {
      const [id, openFlag] = args;
      if (!id || (openFlag && openFlag !== '--open')) throw new Error('invalid countersign arguments');
      const output = platformCutoverEnabled()
        ? await countersign(id, openFlag === '--open')
        : await withRecordLock(id, async () => countersign(loadRecord(id), openFlag === '--open'));
      console.log(JSON.stringify(output, null, 2));
    } else if (command === 'record-gate') {
      const [id, gate, evidence] = args;
      await withRecordLock(id, async () => saveRecord(recordGate(loadRecord(id), gate, evidence,
        { actor: actor() })));
      console.log(JSON.stringify(deriveStatus(loadRecord(id)), null, 2));
    } else if (command === 'file') {
      const [id] = args;
      console.log(JSON.stringify(await withRecordLock(id, async () => file(loadRecord(id))), null, 2));
    } else if (command === 'status') {
      console.log(JSON.stringify(deriveStatus(loadRecord(args[0])), null, 2));
    } else {
      usage();
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { create, plan, start, advance, training, countersign, file, synchronize, validateIntakeForPlatform };
