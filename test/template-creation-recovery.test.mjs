import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectProcessLiveness,
  processStartIdentityFor,
  windowsProcessStartIdentity,
} from '../pipeline/migration-process-lock.mjs';
import {
  createTemplateCreationJournal,
  createTemplateCreationProcessLock,
  pollUncertainCreation,
  recoverPendingCreationBatch,
  stageCreationArtifacts,
  uncertainCreationCandidates,
} from '../pipeline/template-creation-recovery.mjs';

const nameEn = 'W-2 Initial Employment Packet v3';
const nameEs = 'Paquete Inicial de Empleo W-2 v3';
const owner = {
  version: 1,
  pid: 7001,
  workflowId: 'w2-v3-template-creation',
  token: 'owner-token-000000000001',
  host: 'test-host',
  acquiredAt: '2026-07-30T12:00:00.000Z',
  processStartedAt: '2026-07-30T11:59:00.000Z',
  processStartIdentity: 'owner-start-1',
};
const attempt = {
  name: nameEn,
  startedAt: '2026-07-30T12:00:00.000Z',
  knownTemplateIds: ['1', '2'],
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'template-create-transaction-'));
  const paths = [join(dir, 'en.html'), join(dir, 'es.html'), join(dir, 'index.json')];
  writeFileSync(paths[2], 'old-index\n');
  const lockPath = join(dir, 'transaction.lock');
  writeFileSync(lockPath, `${JSON.stringify(owner)}\n`);
  const journal = createTemplateCreationJournal(join(dir, 'transaction.jsonl'), { lockOwner: owner, lockPath });
  journal.beginBatch({
    artifactPaths: paths,
    templates: [{ slug: 'w2-initial-packet-v3', name: nameEn }, { slug: 'w2-initial-packet-es-v3', name: nameEs }],
    startedAt: attempt.startedAt,
  });
  return { dir, paths, journal, lockPath };
}

function recordTemplate(journal, id, name, knownTemplateIds = ['1', '2']) {
  journal.beginAttempt({ name, knownTemplateIds, startedAt: attempt.startedAt });
  journal.recordCreated(id, name);
  journal.recordReadback(id);
}

function assertOriginalArtifacts(paths) {
  assert.equal(existsSync(paths[0]), false);
  assert.equal(existsSync(paths[1]), false);
  assert.equal(readFileSync(paths[2], 'utf8'), 'old-index\n');
}

const inventoryFor = (...entries) => entries.map(([id, name]) => ({
  id,
  name,
  created_at: '2026-07-30T12:00:01.000Z',
  archived_at: null,
}));

function lockOptions(path, overrides = {}) {
  return {
    path,
    staleAfterMs: 60_000,
    now: () => Date.parse('2026-07-30T12:02:00.000Z'),
    host: 'test-host',
    pid: 7002,
    tokenFactory: () => 'new-owner-token-00000002',
    processStartedAt: '2026-07-30T12:01:00.000Z',
    processStartIdentity: 'new-owner-start',
    inspectProcess: () => ({ state: 'dead', startIdentity: null }),
    ...overrides,
  };
}

function lockMetadata(overrides = {}) {
  return { ...owner, ...overrides };
}

test('apply entrypoint acquires ownership before secrets, journal recovery, and provider inventory', () => {
  const source = readFileSync(new URL('../pipeline/build-templates.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('const processLock = createTemplateCreationProcessLock()'));
  const acquire = main.indexOf('processLock.acquire()');
  const secrets = main.indexOf('loadDocusealSecrets()');
  const journal = main.indexOf('createTemplateCreationJournal(');
  const recovery = main.indexOf('recoverPendingCreationBatch(');
  const inventory = main.indexOf('let inventory = await client.listAll(');
  const release = main.lastIndexOf('processLock.release()');
  assert.ok(acquire >= 0 && acquire < secrets && secrets < journal && journal < recovery && recovery < inventory);
  assert.ok(release > inventory);
});

test('a live owner blocks a concurrent invocation before journal or provider access', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'template-create-live-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'create.lock');
  const first = createTemplateCreationProcessLock(lockOptions(path, {
    now: () => Date.parse(owner.acquiredAt),
    pid: owner.pid,
    tokenFactory: () => owner.token,
    processStartedAt: owner.processStartedAt,
    processStartIdentity: owner.processStartIdentity,
  }));
  first.acquire();
  const second = createTemplateCreationProcessLock(lockOptions(path, {
    inspectProcess: () => ({ state: 'alive', startIdentity: owner.processStartIdentity }),
  }));
  let journalReads = 0;
  let providerReads = 0;
  let mutations = 0;
  const invoke = async () => {
    const acquired = second.acquire();
    try {
      journalReads += 1;
      providerReads += 1;
      mutations += 1;
      return acquired;
    } finally {
      second.release();
    }
  };
  await assert.rejects(invoke(), /owner process is still live/);
  assert.deepEqual({ journalReads, providerReads, mutations }, { journalReads: 0, providerReads: 0, mutations: 0 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, owner.token);
  first.release();
});

test('a demonstrably dead owner is reclaimed, its bound journal recovers, then the new owner proceeds', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'template-create-dead-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'create.lock');
  const journalPath = join(dir, 'transaction.json');
  const paths = [join(dir, 'en.html'), join(dir, 'es.html'), join(dir, 'index.json')];
  writeFileSync(paths[2], 'old-index\n');
  writeFileSync(lockPath, `${JSON.stringify(lockMetadata())}\n`);
  const oldJournal = createTemplateCreationJournal(journalPath, { lockOwner: owner, lockPath });
  oldJournal.beginBatch({
    artifactPaths: paths,
    templates: [{ slug: 'w2-initial-packet-v3', name: nameEn }, { slug: 'w2-initial-packet-es-v3', name: nameEs }],
    startedAt: attempt.startedAt,
  });

  const nextLock = createTemplateCreationProcessLock(lockOptions(lockPath));
  const acquired = nextLock.acquire();
  assert.equal(acquired.reclaimed, true);
  assert.equal(acquired.previous.token, owner.token);
  const journal = createTemplateCreationJournal(journalPath, {
    lockOwner: acquired.metadata,
    reclaimedOwner: acquired.previous,
    lockPath,
  });
  const recovered = await recoverPendingCreationBatch({
    journal,
    listInventory: async () => [],
    cleanupTemplate: async () => { throw new Error('should not clean'); },
  });
  assert.deepEqual(recovered, { cleaned: [], restored: true });
  journal.beginBatch({
    artifactPaths: paths,
    templates: [{ slug: 'w2-initial-packet-v3', name: nameEn }, { slug: 'w2-initial-packet-es-v3', name: nameEs }],
    startedAt: '2026-07-30T12:02:00.000Z',
  });
  assert.equal(journal.load().lockOwner.token, acquired.metadata.token);
  journal.complete({ rollback: true });
  nextLock.release();
});

test('failed cleanup journal is atomically adopted by the next fresh exclusive owner', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'template-create-adopt-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'create.lock');
  const journalPath = join(dir, 'transaction.json');
  const paths = [join(dir, 'en.html'), join(dir, 'es.html'), join(dir, 'index.json')];
  writeFileSync(paths[2], 'old-index\n');

  const firstLock = createTemplateCreationProcessLock(lockOptions(lockPath, {
    now: () => Date.parse(owner.acquiredAt),
    pid: owner.pid,
    tokenFactory: () => owner.token,
    processStartedAt: owner.processStartedAt,
    processStartIdentity: owner.processStartIdentity,
  }));
  const firstAcquired = firstLock.acquire();
  const firstJournal = createTemplateCreationJournal(journalPath, {
    lockOwner: firstAcquired.metadata,
    lockPath,
  });
  firstJournal.beginBatch({
    artifactPaths: paths,
    templates: [{ slug: 'w2-initial-packet-v3', name: nameEn }, { slug: 'w2-initial-packet-es-v3', name: nameEs }],
    startedAt: attempt.startedAt,
  });
  recordTemplate(firstJournal, '101', nameEn);
  await assert.rejects(recoverPendingCreationBatch({
    journal: firstJournal,
    listInventory: async () => inventoryFor(['101', nameEn]),
    cleanupTemplate: async () => { throw new Error('first cleanup unavailable'); },
  }), /cleanup incomplete/);
  assert.equal(firstJournal.exists(), true);
  firstLock.release();

  const secondLock = createTemplateCreationProcessLock(lockOptions(lockPath, {
    tokenFactory: () => 'fresh-owner-token-00000003',
  }));
  const secondAcquired = secondLock.acquire();
  assert.equal(secondAcquired.reclaimed, false);
  const secondJournal = createTemplateCreationJournal(journalPath, {
    lockOwner: secondAcquired.metadata,
    lockPath,
  });
  let adoption;
  const result = await recoverPendingCreationBatch({
    journal: secondJournal,
    listInventory: async () => inventoryFor(['101', nameEn]),
    cleanupTemplate: async () => {
      adoption = secondJournal.load().adoptions.at(-1);
    },
  });
  assert.equal(adoption.previousToken, owner.token);
  assert.equal(adoption.token, secondAcquired.metadata.token);
  assert.deepEqual(result, { cleaned: ['101'], restored: true });
  assert.equal(secondJournal.exists(), false);
  assertOriginalArtifacts(paths);
  secondLock.release();
});

test('PID reuse with a different process-start identity permits safe reclaim', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'template-create-pid-reuse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'create.lock');
  writeFileSync(path, `${JSON.stringify(lockMetadata())}\n`);
  const lock = createTemplateCreationProcessLock(lockOptions(path, {
    inspectProcess: () => ({ state: 'alive', startIdentity: 'reused-pid-start' }),
  }));
  const acquired = lock.acquire();
  assert.equal(acquired.reclaimed, true);
  assert.equal(acquired.previous.processStartIdentity, owner.processStartIdentity);
  lock.release();
});

test('Windows process identity uses bounded PowerShell StartTime and strict output validation', () => {
  let invocation;
  const spawnSyncImpl = (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0, signal: null, error: undefined, stdout: ' 133987654321000000\r\n', stderr: '' };
  };
  assert.equal(windowsProcessStartIdentity(4321, { spawnSyncImpl }), 'windows:133987654321000000');
  assert.equal(processStartIdentityFor(4321, { platform: 'win32', spawnSyncImpl }), 'windows:133987654321000000');
  assert.equal(invocation.command, 'powershell.exe');
  assert.match(invocation.args.at(-1), /Get-Process -Id 4321/);
  assert.equal(invocation.options.timeout, 2_000);
  assert.equal(invocation.options.maxBuffer, 1024);

  const invalid = [
    { status: 1, signal: null, stdout: '', stderr: 'denied' },
    { status: 0, signal: null, stdout: 'not-a-time\n', stderr: '' },
    { status: 0, signal: 'SIGTERM', stdout: '123\n', stderr: '' },
    { status: 0, signal: null, error: new Error('timeout'), stdout: '123\n', stderr: '' },
    { status: 0, signal: null, stdout: '123\nextra\n', stderr: '' },
  ];
  for (const result of invalid) {
    assert.equal(windowsProcessStartIdentity(4321, { spawnSyncImpl: () => result }), null);
  }
  assert.equal(windowsProcessStartIdentity(4321, { spawnSyncImpl: () => { throw new Error('spawn'); } }), null);
  assert.deepEqual(inspectProcessLiveness(4321, {
    platform: 'win32',
    kill: () => {},
    spawnSyncImpl: () => { throw new Error('PowerShell unavailable'); },
  }), { state: 'uncertain', startIdentity: null });
});

test('foreign, malformed, and uncertain owners remain blocking with bytes untouched', async (t) => {
  const cases = [
    ['foreign', `${JSON.stringify(lockMetadata({ workflowId: 'foreign-workflow' }))}\n`,
      () => ({ state: 'dead', startIdentity: null }), /different workflow/],
    ['malformed', '{bad-json\n', () => ({ state: 'dead', startIdentity: null }), /malformed or unsupported/],
    ['uncertain', `${JSON.stringify(lockMetadata())}\n`,
      () => ({ state: 'uncertain', startIdentity: null }), /liveness is uncertain/],
  ];
  for (const [label, raw, inspectProcess, error] of cases) {
    await t.test(label, () => {
      const dir = mkdtempSync(join(tmpdir(), `template-create-${label}-lock-`));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'create.lock');
      writeFileSync(path, raw);
      const lock = createTemplateCreationProcessLock(lockOptions(path, { inspectProcess }));
      assert.throws(() => lock.acquire(), error);
      assert.equal(readFileSync(path, 'utf8'), raw);
    });
  }
});

test('journal access requires actual ownership of the exclusive lock', () => {
  const { journal, lockPath } = fixture();
  assert.throws(() => createTemplateCreationJournal(journal.path, {
    lockOwner: lockMetadata({ token: 'unrelated-owner-token-0001' }),
    lockPath,
  }), /lock is not owned/);
  assert.equal(journal.exists(), true);
});

test('uncertain creation reconciliation selects only new exact-name active candidates', () => {
  const candidates = uncertainCreationCandidates([
    { id: 1, name: attempt.name, created_at: '2026-07-30T12:00:01.000Z', archived_at: null },
    { id: 3, name: attempt.name, created_at: '2026-07-30T12:00:01.000Z', archived_at: null },
    { id: 4, name: `${attempt.name} `, created_at: '2026-07-30T12:00:01.000Z', archived_at: null },
    { id: 5, name: attempt.name, created_at: '2026-07-30T11:00:00.000Z', archived_at: null },
    { id: 6, name: attempt.name, created_at: '2026-07-30T12:00:01.000Z', archived_at: '2026-07-30T12:00:02.000Z' },
  ], attempt);
  assert.deepEqual(candidates.map((entry) => entry.id), [3]);
  assert.throws(
    () => uncertainCreationCandidates([
      { id: 3, name: attempt.name, archived_at: null },
      { id: 3, name: attempt.name, archived_at: null },
    ], attempt),
    /duplicate candidate IDs/,
  );
});

test('poll reconciles a successful POST whose Location header was omitted', async () => {
  let reads = 0;
  const candidates = await pollUncertainCreation({
    attempt,
    attempts: 3,
    wait: async () => {},
    listInventory: async () => {
      reads += 1;
      return reads < 2 ? [] : [{ id: 7, name: attempt.name, archived_at: null }];
    },
  });
  assert.equal(reads, 2);
  assert.deepEqual(candidates.map((entry) => entry.id), [7]);
});

for (const boundary of ['after-first-readback', 'after-second-readback']) {
  test(`batch recovery cleans every known template and restores artifacts ${boundary}`, async () => {
    const { paths, journal } = fixture();
    recordTemplate(journal, '101', nameEn);
    if (boundary === 'after-second-readback') recordTemplate(journal, '102', nameEs, ['1', '2', '101']);
    const cleaned = [];
    const result = await recoverPendingCreationBatch({
      journal,
      listInventory: async () => inventoryFor(['101', nameEn], ['102', nameEs]),
      cleanupTemplate: async (id) => cleaned.push(id),
    });
    assert.deepEqual(cleaned, boundary === 'after-first-readback' ? ['101'] : ['101', '102']);
    assert.deepEqual(result, { cleaned, restored: true });
    assertOriginalArtifacts(paths);
    assert.equal(journal.exists(), false);
  });
}

for (const boundary of ['after-staging-plan', 'after-artifact-1', 'after-artifact-2', 'after-artifact-3', 'after-artifacts-staged']) {
  test(`fault injection rolls back both templates and all local files ${boundary}`, async () => {
    const { paths, journal } = fixture();
    recordTemplate(journal, '101', nameEn);
    recordTemplate(journal, '102', nameEs, ['1', '2', '101']);
    assert.throws(() => stageCreationArtifacts({
      journal,
      artifacts: paths.map((path, index) => ({ path, contents: `new-${index}\n` })),
      fault: (point) => { if (point === boundary) throw new Error(`fault ${point}`); },
    }), /fault/);
    const cleaned = [];
    await recoverPendingCreationBatch({
      journal,
      listInventory: async () => inventoryFor(['101', nameEn], ['102', nameEs]),
      cleanupTemplate: async (id) => cleaned.push(id),
    });
    assert.deepEqual(cleaned, ['101', '102']);
    assertOriginalArtifacts(paths);
    assert.equal(journal.exists(), false);
  });
}

test('normal journal completion is structurally blocked before the full batch is durable', () => {
  const { journal } = fixture();
  assert.throws(() => journal.complete(), /cannot complete before both readbacks/);
  recordTemplate(journal, '101', nameEn);
  assert.throws(() => journal.complete(), /cannot complete before both readbacks/);
  assert.equal(journal.exists(), true);
});

test('journal remains until all artifact bytes pass durable readback and explicit completion', () => {
  const { paths, journal } = fixture();
  recordTemplate(journal, '101', nameEn);
  recordTemplate(journal, '102', nameEs, ['1', '2', '101']);
  stageCreationArtifacts({
    journal,
    artifacts: paths.map((path, index) => ({ path, contents: `new-${index}\n` })),
  });
  assert.equal(journal.exists(), true);
  assert.equal(journal.load().artifactsStaged, true);
  paths.forEach((path, index) => assert.equal(readFileSync(path, 'utf8'), `new-${index}\n`));
  journal.complete();
  assert.equal(journal.exists(), false);
});

test('recovery cleans recorded templates plus every candidate from an uncertain second POST', async () => {
  const { paths, journal } = fixture();
  recordTemplate(journal, '101', nameEn);
  journal.beginAttempt({ name: nameEs, knownTemplateIds: ['1', '2', '101'], startedAt: attempt.startedAt });
  const cleaned = [];
  await recoverPendingCreationBatch({
    journal,
    wait: async () => {},
    listInventory: async () => inventoryFor(['101', nameEn], ['102', nameEs], ['103', nameEs]),
    cleanupTemplate: async (id) => cleaned.push(id),
  });
  assert.deepEqual(cleaned, ['101', '102', '103']);
  assertOriginalArtifacts(paths);
});

test('recovery retry skips an already archived first cleanup and finishes the transaction', async () => {
  const { paths, journal } = fixture();
  recordTemplate(journal, '101', nameEn);
  recordTemplate(journal, '102', nameEs, ['1', '2', '101']);
  const cleaned = [];
  await recoverPendingCreationBatch({
    journal,
    listInventory: async () => [
      { id: '101', name: nameEn, archived_at: '2026-07-30T12:01:00.000Z' },
      { id: '102', name: nameEs, archived_at: null },
    ],
    cleanupTemplate: async (id) => cleaned.push(id),
  });
  assert.deepEqual(cleaned, ['102']);
  assertOriginalArtifacts(paths);
  assert.equal(journal.exists(), false);
});

test('partial trailing journal event is ignored and prior durable state remains recoverable', async () => {
  const { paths, journal } = fixture();
  recordTemplate(journal, '101', nameEn);
  appendFileSync(journal.path, '{"type":"readback"');
  assert.deepEqual(journal.load().readbackIds, ['101']);
  const cleaned = [];
  await recoverPendingCreationBatch({
    journal,
    listInventory: async () => inventoryFor(['101', nameEn]),
    cleanupTemplate: async (id) => cleaned.push(id),
  });
  assert.deepEqual(cleaned, ['101']);
  assertOriginalArtifacts(paths);
});

test('unresolved POST, remote cleanup failure, or artifact rollback failure retains journal', async (t) => {
  await t.test('unresolved POST', async () => {
    const { journal } = fixture();
    journal.beginAttempt({ ...attempt });
    await assert.rejects(recoverPendingCreationBatch({
      journal,
      wait: async () => {},
      listInventory: async () => [],
      cleanupTemplate: async () => {},
    }), /journal retained/);
    assert.equal(journal.exists(), true);
  });

  await t.test('remote cleanup failure', async () => {
    const { journal } = fixture();
    recordTemplate(journal, '101', nameEn);
    await assert.rejects(recoverPendingCreationBatch({
      journal,
      listInventory: async () => inventoryFor(['101', nameEn]),
      cleanupTemplate: async () => { throw new Error('provider unavailable'); },
    }), /cleanup incomplete/);
    assert.equal(journal.exists(), true);
  });

  await t.test('artifact backup digest failure', async () => {
    const { journal } = fixture();
    recordTemplate(journal, '101', nameEn);
    const backup = journal.load().artifacts[2].backupPath;
    writeFileSync(backup, 'corrupt');
    await assert.rejects(recoverPendingCreationBatch({
      journal,
      listInventory: async () => inventoryFor(['101', nameEn]),
      cleanupTemplate: async () => {},
    }), /artifact rollback incomplete/);
    assert.equal(journal.exists(), true);
  });
});
