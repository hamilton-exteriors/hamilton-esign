import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

const LOCK_VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 60_000;

function createExclusiveFile(path, contents) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function linuxProcessStartIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fieldsAfterCommand = stat.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    if (!/^\d+$/.test(startTicks || '')) return null;
    let bootId = '';
    try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
    catch { return null; }
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return null;
  }
}

export function inspectProcessLiveness(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: 'dead', startIdentity: null };
    return { state: 'uncertain', startIdentity: null };
  }
  return { state: 'alive', startIdentity: linuxProcessStartIdentity(pid) };
}

function parseLock(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch { return null; }
  if (value?.version !== LOCK_VERSION || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.workflowId !== 'string' || !value.workflowId ||
      typeof value.token !== 'string' || value.token.length < 16 ||
      typeof value.host !== 'string' || !value.host ||
      typeof value.acquiredAt !== 'string' || !Number.isFinite(Date.parse(value.acquiredAt)) ||
      typeof value.processStartedAt !== 'string' || !Number.isFinite(Date.parse(value.processStartedAt)) ||
      !([null, 'string'].includes(value.processStartIdentity === null ? null : typeof value.processStartIdentity))) {
    return null;
  }
  return value;
}

function lockError(path, reason = '') {
  const detail = reason ? ` (${reason})` : '';
  return new Error(`another migration process holds the exclusive lock at ${path}${detail}`);
}

function restoreMovedLock(path, movedPath) {
  try { renameSync(movedPath, path); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

export function createMigrationProcessLock({
  path,
  workflowId,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = () => Date.now(),
  host = hostname(),
  pid = process.pid,
  tokenFactory = randomUUID,
  processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString(),
  processStartIdentity = linuxProcessStartIdentity(process.pid),
  inspectProcess = inspectProcessLiveness,
} = {}) {
  if (!path || !workflowId) throw new Error('migration lock path and workflow ID are required');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error('migration lock stale interval is invalid');
  const token = tokenFactory();
  const metadata = Object.freeze({
    version: LOCK_VERSION,
    pid,
    workflowId,
    token,
    host,
    acquiredAt: new Date(now()).toISOString(),
    processStartedAt,
    processStartIdentity: processStartIdentity || null,
  });
  const serialized = `${JSON.stringify(metadata)}\n`;
  let held = false;

  function claimFresh() {
    createExclusiveFile(path, serialized);
    held = true;
    return { reclaimed: false, metadata };
  }

  function assessExisting(raw) {
    const existing = parseLock(raw);
    if (!existing) throw lockError(path, 'owner metadata is malformed or unsupported');
    if (existing.workflowId !== workflowId) throw lockError(path, 'owner belongs to a different workflow');
    if (existing.host !== host) throw lockError(path, 'owner is on another or unknown host');
    if (now() - Date.parse(existing.acquiredAt) < staleAfterMs) throw lockError(path, 'owner lock is not stale');

    const observed = inspectProcess(existing.pid);
    if (observed?.state === 'dead') return existing;
    if (observed?.state === 'alive' && existing.processStartIdentity && observed.startIdentity &&
        observed.startIdentity !== existing.processStartIdentity) {
      return existing;
    }
    if (observed?.state === 'alive') throw lockError(path, 'owner process is still live');
    throw lockError(path, 'owner process liveness is uncertain');
  }

  return {
    path,
    metadata,
    acquire() {
      if (held) return { reclaimed: false, metadata };
      mkdirSync(dirname(path), { recursive: true });
      try {
        return claimFresh();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      const candidateRaw = readFileSync(path, 'utf8');
      const candidate = assessExisting(candidateRaw);
      const movedPath = `${path}.reclaim-${pid}-${token}`;
      try {
        renameSync(path, movedPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          try { return claimFresh(); }
          catch (claimError) {
            if (claimError?.code === 'EEXIST') throw lockError(path, 'lock ownership changed during reclaim');
            throw claimError;
          }
        }
        throw error;
      }

      const movedRaw = readFileSync(movedPath, 'utf8');
      const moved = parseLock(movedRaw);
      if (movedRaw !== candidateRaw || moved?.token !== candidate.token) {
        restoreMovedLock(path, movedPath);
        throw lockError(path, 'lock ownership changed during reclaim');
      }
      try {
        claimFresh();
      } catch (error) {
        restoreMovedLock(path, movedPath);
        if (error?.code === 'EEXIST') throw lockError(path, 'another process won lock reclaim');
        throw error;
      }
      rmSync(movedPath, { force: true });
      return { reclaimed: true, metadata, previous: candidate };
    },
    release() {
      if (!held) return;
      const movedPath = `${path}.release-${pid}-${token}`;
      try {
        renameSync(path, movedPath);
      } catch (error) {
        held = false;
        if (error?.code === 'ENOENT') throw new Error(`migration lock disappeared before release at ${path}`);
        throw error;
      }
      const moved = parseLock(readFileSync(movedPath, 'utf8'));
      if (moved?.workflowId !== workflowId || moved?.token !== token) {
        restoreMovedLock(path, movedPath);
        held = false;
        throw new Error(`migration lock ownership changed before release at ${path}`);
      }
      rmSync(movedPath, { force: true });
      held = false;
    },
  };
}
