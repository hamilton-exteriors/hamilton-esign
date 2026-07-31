import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createExclusiveFile, removeExclusiveFile } from './template-mutation-safety.mjs';
import { createMigrationProcessLock } from './migration-process-lock.mjs';

export const TEMPLATE_CREATION_WORKFLOW_ID = 'w2-v3-template-creation';
export const DEFAULT_TEMPLATE_CREATION_JOURNAL = join(
  homedir(), '.claude', '.hamilton-state', 'template-creations', 'w2-v3-create.json',
);
export const DEFAULT_TEMPLATE_CREATION_LOCK = join(
  homedir(), '.claude', '.hamilton-state', 'template-creations', 'w2-v3-create.lock',
);

export function createTemplateCreationProcessLock(options = {}) {
  return createMigrationProcessLock({
    ...options,
    path: options.path || DEFAULT_TEMPLATE_CREATION_LOCK,
    workflowId: TEMPLATE_CREATION_WORKFLOW_ID,
  });
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function durableWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try {
    fd = openSync(path, 'w', 0o600);
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function appendEvent(path, event) {
  let fd;
  try {
    fd = openSync(path, 'a', 0o600);
    writeFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function truncatePartialEvent(path) {
  const bytes = readFileSync(path);
  if (bytes.length && bytes[bytes.length - 1] === 0x0a) return;
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) throw new Error(`template creation journal has no durable event at ${path}`);
  truncateSync(path, lastNewline + 1);
  let fd;
  try {
    fd = openSync(path, 'r+');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validAttempt(value) {
  return value && typeof value.name === 'string' && value.name &&
    typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) &&
    Array.isArray(value.knownTemplateIds) && value.knownTemplateIds.every((id) => id != null);
}

function validLockOwner(value) {
  return value && value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    value.workflowId === TEMPLATE_CREATION_WORKFLOW_ID && typeof value.token === 'string' && value.token.length >= 16 &&
    typeof value.host === 'string' && value.host && typeof value.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(value.acquiredAt)) && typeof value.processStartedAt === 'string' &&
    Number.isFinite(Date.parse(value.processStartedAt));
}

function replayJournal(text, path, authorizedTokens) {
  const completeLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n').slice(0, -1);
  if (!completeLines.length) throw new Error(`empty template creation journal at ${path}`);
  const events = completeLines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`invalid template creation journal event ${index} at ${path}`); }
  });
  const header = events[0];
  if (header?.type !== 'begin' || header.version !== 2 || !Array.isArray(header.artifacts) ||
    !Array.isArray(header.templates) || header.templates.length !== 2 || !validLockOwner(header.lockOwner)) {
    throw new Error(`invalid template creation journal header at ${path}`);
  }
  const state = {
    version: header.version,
    startedAt: header.startedAt,
    lockOwner: header.lockOwner,
    adoptions: [],
    templates: header.templates,
    artifacts: header.artifacts,
    pending: null,
    created: [],
    readbackIds: [],
    stagingPlan: null,
    artifactsStaged: false,
  };
  for (const event of events.slice(1)) {
    if (event.type === 'adopt') {
      if (event.previousToken !== state.lockOwner.token || !validLockOwner(event.lockOwner) ||
        typeof event.adoptedAt !== 'string' || !Number.isFinite(Date.parse(event.adoptedAt))) {
        throw new Error(`invalid journal ownership adoption at ${path}`);
      }
      state.adoptions.push({
        previousToken: event.previousToken,
        token: event.lockOwner.token,
        adoptedAt: event.adoptedAt,
      });
      state.lockOwner = event.lockOwner;
    } else if (event.type === 'attempt') {
      if (!validAttempt(event.attempt)) throw new Error(`invalid creation attempt event at ${path}`);
      state.pending = event.attempt;
    } else if (event.type === 'created') {
      if (event.id == null || !state.pending || event.name !== state.pending.name) {
        throw new Error(`invalid created-template event at ${path}`);
      }
      if (state.created.some((entry) => String(entry.id) === String(event.id))) {
        throw new Error(`duplicate created-template ID in ${path}`);
      }
      state.created.push({ id: event.id, name: event.name });
      state.pending = null;
    } else if (event.type === 'resolved-candidates') {
      if (!state.pending || event.name !== state.pending.name || !Array.isArray(event.ids) || !event.ids.length) {
        throw new Error(`invalid resolved-candidates event at ${path}`);
      }
      for (const id of event.ids) {
        if (id == null || state.created.some((entry) => String(entry.id) === String(id))) {
          throw new Error(`duplicate or invalid resolved candidate in ${path}`);
        }
        state.created.push({ id, name: event.name });
      }
      state.pending = null;
    } else if (event.type === 'readback') {
      if (!state.created.some((entry) => String(entry.id) === String(event.id))) {
        throw new Error(`readback references unknown template in ${path}`);
      }
      if (!state.readbackIds.some((id) => String(id) === String(event.id))) state.readbackIds.push(event.id);
    } else if (event.type === 'staging-plan') {
      if (state.stagingPlan || !Array.isArray(event.artifacts) || event.artifacts.length !== state.artifacts.length ||
        event.artifacts.some((artifact, index) => artifact.path !== state.artifacts[index].target ||
          typeof artifact.planPath !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256))) {
        throw new Error(`invalid artifact staging plan at ${path}`);
      }
      state.stagingPlan = event.artifacts;
    } else if (event.type === 'artifacts-staged') {
      if (!state.stagingPlan) throw new Error(`artifacts staged without a durable plan at ${path}`);
      state.artifactsStaged = true;
    } else {
      throw new Error(`unknown template creation journal event at ${path}`);
    }
  }
  if (authorizedTokens && !authorizedTokens.has(state.lockOwner.token)) {
    throw new Error(`template creation journal belongs to a lock owner that was not safely reclaimed at ${path}`);
  }
  return state;
}

export function createTemplateCreationJournal(
  path = DEFAULT_TEMPLATE_CREATION_JOURNAL,
  { lockOwner, reclaimedOwner = null, lockPath = DEFAULT_TEMPLATE_CREATION_LOCK } = {},
) {
  if (!validLockOwner(lockOwner)) throw new Error('current template creation lock owner is required');
  if (reclaimedOwner && !validLockOwner(reclaimedOwner)) throw new Error('reclaimed template creation lock owner is invalid');
  function assertCurrentLockOwner() {
    let current;
    try { current = JSON.parse(readFileSync(lockPath, 'utf8')); }
    catch { throw new Error(`template creation lock ownership cannot be verified at ${lockPath}`); }
    if (!validLockOwner(current) || current.token !== lockOwner.token) {
      throw new Error(`template creation lock is not owned by the current journal process at ${lockPath}`);
    }
  }
  assertCurrentLockOwner();
  const authorizedTokens = new Set([lockOwner.token, reclaimedOwner?.token].filter(Boolean));
  const backupDir = `${path}.backups`;
  return {
    path,
    backupDir,
    exists: () => existsSync(path),
    adopt({ adoptedAt = new Date().toISOString() } = {}) {
      assertCurrentLockOwner();
      if (!existsSync(path)) return { adopted: false, previousToken: null };
      truncatePartialEvent(path);
      const prior = replayJournal(readFileSync(path, 'utf8'), path, null);
      if (prior.lockOwner.token === lockOwner.token) return { adopted: false, previousToken: null };
      const previousToken = prior.lockOwner.token;
      appendEvent(path, {
        type: 'adopt',
        previousToken,
        lockOwner,
        adoptedAt,
      });
      const adopted = replayJournal(readFileSync(path, 'utf8'), path, authorizedTokens);
      if (adopted.lockOwner.token !== lockOwner.token) throw new Error('template creation journal adoption did not persist');
      return { adopted: true, previousToken };
    },
    load() {
      return replayJournal(readFileSync(path, 'utf8'), path, authorizedTokens);
    },
    beginBatch({ artifactPaths, templates, startedAt = new Date().toISOString() }) {
      if (!Array.isArray(artifactPaths) || !artifactPaths.length || new Set(artifactPaths).size !== artifactPaths.length) {
        throw new Error('template creation artifact targets must be unique and nonempty');
      }
      if (!Array.isArray(templates) || templates.length !== 2 ||
        templates.some((template) => typeof template?.name !== 'string' || !template.name ||
          typeof template?.slug !== 'string' || !template.slug) ||
        new Set(templates.map((template) => template.name)).size !== templates.length ||
        new Set(templates.map((template) => template.slug)).size !== templates.length) {
        throw new Error('template creation transaction requires two unique named template targets');
      }
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) rmSync(backupDir, { recursive: true, force: true });
      mkdirSync(backupDir, { recursive: false });
      const artifacts = artifactPaths.map((target, index) => {
        const existed = existsSync(target);
        const backupPath = existed ? join(backupDir, `${String(index).padStart(2, '0')}-${basename(target)}.bak`) : null;
        if (existed) {
          copyFileSync(target, backupPath);
          durableWrite(backupPath, readFileSync(backupPath));
        }
        return { target, existed, backupPath, sha256: existed ? digest(readFileSync(target)) : null };
      });
      syncDirectory(backupDir);
      const header = { type: 'begin', version: 2, startedAt, lockOwner, templates, artifacts };
      try {
        createExclusiveFile(path, `${JSON.stringify(header)}\n`);
        syncDirectory(dirname(path));
      } catch (error) {
        rmSync(backupDir, { recursive: true, force: true });
        throw error;
      }
      return this.load();
    },
    beginAttempt({ name, knownTemplateIds, startedAt = new Date().toISOString() }) {
      const state = this.load();
      if (state.pending) throw new Error('a template creation attempt is already unresolved');
      const target = state.templates[state.created.length];
      if (!target || target.name !== name ||
        state.created.some((entry) => !state.readbackIds.some((id) => String(id) === String(entry.id)))) {
        throw new Error('template creation attempt is out of declared transaction order');
      }
      const attempt = { name, startedAt, knownTemplateIds: [...new Set([...knownTemplateIds].map(String))] };
      if (!validAttempt(attempt)) throw new Error('template creation attempt metadata is invalid');
      appendEvent(path, { type: 'attempt', attempt });
      return attempt;
    },
    recordCreated(id, name) {
      appendEvent(path, { type: 'created', id, name });
      return this.load();
    },
    recordCandidates(ids, name) {
      appendEvent(path, { type: 'resolved-candidates', ids, name });
      return this.load();
    },
    recordReadback(id) {
      appendEvent(path, { type: 'readback', id });
      return this.load();
    },
    recordStagingPlan(artifacts) {
      const state = this.load();
      if (state.stagingPlan) throw new Error('artifact staging plan is already durable');
      if (state.pending || state.created.length !== state.templates.length ||
        state.created.some((entry, index) => entry.name !== state.templates[index].name ||
          !state.readbackIds.some((id) => String(id) === String(entry.id)))) {
        throw new Error('artifact staging requires both declared templates and exact readbacks');
      }
      if (!Array.isArray(artifacts) || artifacts.length !== state.artifacts.length ||
        artifacts.some((artifact, index) => artifact.path !== state.artifacts[index].target)) {
        throw new Error('artifact staging plan differs from creation journal targets');
      }
      const plan = artifacts.map((artifact, index) => {
        const planPath = join(backupDir, `${String(index).padStart(2, '0')}-${basename(artifact.path)}.target`);
        durableWrite(planPath, artifact.contents);
        return { path: artifact.path, planPath, sha256: digest(readFileSync(planPath)) };
      });
      syncDirectory(backupDir);
      appendEvent(path, { type: 'staging-plan', artifacts: plan });
      return this.load();
    },
    recordArtifactsStaged() {
      appendEvent(path, { type: 'artifacts-staged' });
      return this.load();
    },
    restoreArtifacts() {
      const state = this.load();
      for (const artifact of state.artifacts) {
        if (artifact.existed) {
          const bytes = readFileSync(artifact.backupPath);
          if (digest(bytes) !== artifact.sha256) throw new Error(`artifact backup digest changed for ${artifact.target}`);
          durableWrite(artifact.target, bytes);
        } else {
          rmSync(artifact.target, { force: true });
          syncDirectory(dirname(artifact.target));
        }
      }
    },
    complete({ rollback = false } = {}) {
      const state = this.load();
      if (!rollback && (!state.artifactsStaged || state.created.length !== state.templates.length ||
        state.created.some((entry) => !state.readbackIds.some((id) => String(id) === String(entry.id))))) {
        throw new Error('creation journal cannot complete before both readbacks and durable artifact staging');
      }
      removeExclusiveFile(path);
      syncDirectory(dirname(path));
      rmSync(backupDir, { recursive: true, force: true });
      syncDirectory(dirname(path));
    },
  };
}

export function uncertainCreationCandidates(inventory, attempt) {
  if (!validAttempt(attempt)) throw new Error('template creation attempt metadata is invalid');
  const known = new Set(attempt.knownTemplateIds.map(String));
  const earliest = Date.parse(attempt.startedAt) - 5_000;
  const candidates = (inventory || []).filter((template) => {
    if (!template || template.id == null || template.archived_at || template.name !== attempt.name || known.has(String(template.id))) return false;
    if (template.created_at !== undefined) {
      const createdAt = Date.parse(template.created_at);
      if (!Number.isFinite(createdAt) || createdAt < earliest) return false;
    }
    return true;
  });
  const ids = candidates.map((template) => String(template.id));
  if (new Set(ids).size !== ids.length) throw new Error('template inventory returned duplicate candidate IDs');
  return candidates;
}

export async function pollUncertainCreation({
  attempt,
  listInventory,
  attempts = 4,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  for (let index = 0; index < attempts; index += 1) {
    const candidates = uncertainCreationCandidates(await listInventory(), attempt);
    if (candidates.length) return candidates;
    if (index + 1 < attempts) await wait(250 * (index + 1));
  }
  return [];
}

export function stageCreationArtifacts({ journal, artifacts, fault = () => {} }) {
  let state = journal.load();
  const expected = state.artifacts.map((artifact) => artifact.target);
  if (!Array.isArray(artifacts) || artifacts.length !== expected.length ||
    artifacts.some((artifact, index) => artifact.path !== expected[index])) {
    throw new Error('staged artifact set/order differs from creation journal');
  }
  state = journal.recordStagingPlan(artifacts);
  fault('after-staging-plan');
  state.stagingPlan.forEach((artifact, index) => {
    const contents = readFileSync(artifact.planPath);
    if (digest(contents) !== artifact.sha256) throw new Error(`artifact staging plan digest changed for ${artifact.path}`);
    durableWrite(artifact.path, contents);
    fault(`after-artifact-${index + 1}`);
  });
  state.stagingPlan.forEach((artifact) => {
    if (digest(readFileSync(artifact.path)) !== artifact.sha256) {
      throw new Error(`durable artifact readback failed for ${artifact.path}`);
    }
  });
  journal.recordArtifactsStaged();
  fault('after-artifacts-staged');
}

export async function recoverPendingCreationBatch({ journal, listInventory, cleanupTemplate, wait }) {
  if (!journal.exists()) return { cleaned: [], restored: false };
  journal.adopt();
  let state = journal.load();
  const waitForRetry = wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let inventory = [];
  let missingRecorded = [];
  for (let index = 0; index < 4; index += 1) {
    inventory = await listInventory();
    const inventoryIds = new Set((inventory || []).filter((entry) => entry?.id != null).map((entry) => String(entry.id)));
    missingRecorded = state.created.filter((entry) => !inventoryIds.has(String(entry.id)));
    if (!missingRecorded.length) break;
    if (index < 3) await waitForRetry(250 * (index + 1));
  }
  if (missingRecorded.length) {
    throw new Error(`tracked template(s) absent from provider inventory; journal retained: ${missingRecorded.map((entry) => entry.id).join(', ')}`);
  }

  if (state.pending) {
    const candidates = await pollUncertainCreation({ attempt: state.pending, listInventory, wait: waitForRetry });
    if (!candidates.length) {
      throw new Error(`unresolved template creation ambiguity for ${state.pending.name}; journal retained at ${journal.path}`);
    }
    journal.recordCandidates(candidates.map((candidate) => candidate.id), state.pending.name);
    inventory = [...inventory, ...candidates.filter((candidate) =>
      !(inventory || []).some((entry) => String(entry.id) === String(candidate.id)))];
    state = journal.load();
  }

  const inventoryById = new Map((inventory || []).filter((entry) => entry?.id != null).map((entry) => [String(entry.id), entry]));
  const cleanupIds = state.created
    .filter((entry) => !inventoryById.get(String(entry.id))?.archived_at)
    .map((entry) => String(entry.id));
  const cleaned = [];
  const failures = [];
  for (const id of cleanupIds) {
    try {
      await cleanupTemplate(id);
      cleaned.push(id);
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`template creation batch cleanup incomplete; journal retained: ${failures.join('; ')}`);
  try {
    journal.restoreArtifacts();
  } catch (error) {
    throw new Error(`template creation artifact rollback incomplete; journal retained: ${error.message}`);
  }
  journal.complete({ rollback: true });
  return { cleaned, restored: true };
}
