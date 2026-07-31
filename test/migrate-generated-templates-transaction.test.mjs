import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFileJournalStore,
  GENERATED_MIGRATION_WORKFLOW_ID,
  guardedTemplateState,
  parseMigrationArgs,
  recoverMigrationJournal,
  runMigrationTransaction,
} from '../pipeline/migrate-generated-templates.mjs';
import {
  createIippMigrationProcessLock,
  IIPP_MIGRATION_WORKFLOW_ID,
} from '../pipeline/migrate-iipp.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const LOCK_NOW = Date.parse('2026-07-30T12:00:00.000Z');

function lockMetadata(overrides = {}) {
  return {
    version: 1,
    pid: 4242,
    workflowId: GENERATED_MIGRATION_WORKFLOW_ID,
    token: 'dead-owner-token-0001',
    host: 'test-host',
    acquiredAt: '2026-07-30T11:00:00.000Z',
    processStartedAt: '2026-07-30T10:00:00.000Z',
    processStartIdentity: 'test-start-1',
    ...overrides,
  };
}

function seedLock(store, metadata) {
  writeFileSync(store.lockPath, `${JSON.stringify(metadata)}\n`, 'utf8');
}

function lockOptions(inspectProcess) {
  return {
    now: () => LOCK_NOW,
    staleAfterMs: 1_000,
    host: 'test-host',
    pid: 7777,
    tokenFactory: () => 'new-owner-token-0002',
    processStartedAt: '2026-07-30T11:59:00.000Z',
    processStartIdentity: 'test-start-new',
    inspectProcess,
  };
}

function template(id, slug) {
  return {
    id,
    name: `Composite ${slug}`,
    schema: [{ name: slug, attachment_uuid: `old-${slug}` }],
    documents: [{ url: `https://invalid.test/${slug}.pdf` }],
    submitters: [{ uuid: `role-${slug}`, name: 'Worker' }],
    fields: [{
      uuid: `field-${slug}`,
      name: 'Signature',
      type: 'signature',
      submitter_uuid: `role-${slug}`,
      areas: [{ page: 0, x: 1, y: 2, w: 3, h: 4, attachment_uuid: `old-${slug}` }],
    }],
  };
}

function item(id, slug) {
  const before = template(id, slug);
  return {
    entry: { slug },
    template: before,
    plan: {
      changes: ['Signature geometry'],
      targetByUuid: new Map([[
        `field-${slug}`,
        { type: 'signature', page: 0, x: 10, y: 20, w: 30, h: 40 },
      ]]),
    },
    pdf: Buffer.from(`pdf-${slug}`),
  };
}

function harness(t, items, lockOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'esign-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalStore = createFileJournalStore(join(directory, 'journal.json'), lockOptions);
  const live = new Map(items.map(({ template: value }) => [value.id, clone(value)]));
  const writes = [];
  return {
    journalStore,
    live,
    writes,
    readTemplate: async (id) => clone(live.get(id)),
    uploadPdf: async (id, _pdf, filename) => ({
      csrf: `csrf-${id}`,
      schema: [{ name: filename.replace(/\.pdf$/, ''), attachment_uuid: `new-${id}` }],
    }),
    conditionalWriteTemplate: async (id, expected, state, context) => {
      if (JSON.stringify(guardedTemplateState(live.get(id))) !== JSON.stringify(expected)) {
        throw new Error('provider CAS precondition failed');
      }
      writes.push({ id, state: clone(state), context });
      live.set(id, clone(state));
    },
  };
}

test('argument parser accepts spaced and equals slug forms while apply stays explicit', () => {
  assert.deepEqual(parseMigrationArgs([]), { apply: false, requestedSlug: '' });
  assert.deepEqual(parseMigrationArgs(['--slug', 'combined-w2', '--apply']), {
    apply: true,
    requestedSlug: 'combined-w2',
  });
  assert.deepEqual(parseMigrationArgs(['--apply', '--slug=combined-w2']), {
    apply: true,
    requestedSlug: 'combined-w2',
  });
  assert.throws(() => parseMigrationArgs(['--slug']), /requires a document slug/);
  assert.throws(() => parseMigrationArgs(['--slug', '--apply']), /requires a document slug/);
  assert.throws(() => parseMigrationArgs(['--slug=a', '--slug', 'b']), /duplicate --slug/);
  assert.throws(() => parseMigrationArgs(['--unknown']), /usage:/);
});

test('partial failure rolls back every earlier write and removes the journal', async (t) => {
  const items = [item(1, 'first'), item(2, 'second')];
  const h = harness(t, items);
  const originalWrite = h.conditionalWriteTemplate;
  h.conditionalWriteTemplate = async (id, expected, state, context, csrf) => {
    if (id === 2 && context === 'write second') throw new Error('injected second write failure');
    return originalWrite(id, expected, state, context, csrf);
  };

  await assert.rejects(
    runMigrationTransaction(items, { ...h, log: () => {} }),
    /all possible mutations were rolled back.*injected second write failure/,
  );
  assert.deepEqual(guardedTemplateState(h.live.get(1)), guardedTemplateState(items[0].template));
  assert.deepEqual(guardedTemplateState(h.live.get(2)), guardedTemplateState(items[1].template));
  assert.equal(h.journalStore.exists(), false);
  assert.match(h.writes.at(-1).context, /rollback first/);
});

test('uncertain committed write is reconciled and rolled back after failure', async (t) => {
  const items = [item(1, 'first')];
  const h = harness(t, items);
  const originalWrite = h.conditionalWriteTemplate;
  h.conditionalWriteTemplate = async (id, expected, state, context, csrf) => {
    await originalWrite(id, expected, state, context, csrf);
    if (context === 'write first') throw new Error('connection dropped after commit');
  };

  await assert.rejects(
    runMigrationTransaction(items, { ...h, log: () => {} }),
    /connection dropped after commit/,
  );
  assert.deepEqual(guardedTemplateState(h.live.get(1)), guardedTemplateState(items[0].template));
  assert.equal(h.journalStore.exists(), false);
});

test('dead stale lock is reclaimed and interrupted journal recovery resumes safely', async (t) => {
  const items = [item(1, 'first')];
  const h = harness(t, items, lockOptions(() => ({ state: 'dead', startIdentity: null })));
  const before = guardedTemplateState(items[0].template);
  const written = clone(before);
  written.schema = [{ name: 'first', attachment_uuid: 'new-1' }];
  written.fields[0].areas[0] = {
    page: 0, x: 10, y: 20, w: 30, h: 40, attachment_uuid: 'new-1',
  };
  h.live.set(1, clone(written));
  h.journalStore.create({
    version: 1,
    status: 'active',
    entries: [{ slug: 'first', templateId: 1, phase: 'writing', before, written }],
  });
  seedLock(h.journalStore, lockMetadata());

  assert.equal(await recoverMigrationJournal({ ...h, log: () => {} }), true);
  assert.deepEqual(guardedTemplateState(h.live.get(1)), guardedTemplateState(items[0].template));
  assert.equal(h.journalStore.exists(), false);

  await runMigrationTransaction(items, { ...h, log: () => {} });
  assert.equal(h.live.get(1).schema[0].attachment_uuid, 'new-1');
  assert.equal(h.journalStore.exists(), false);
  assert.equal(h.writes.length, 2);
});

test('recovery refuses to overwrite a concurrent edit and retains its journal', async (t) => {
  const items = [item(1, 'first')];
  const h = harness(t, items);
  const before = guardedTemplateState(items[0].template);
  const written = clone(before);
  written.schema = [{ name: 'first', attachment_uuid: 'new-1' }];
  const concurrent = clone(written);
  concurrent.fields[0].name = 'Edited by another operator';
  h.live.set(1, concurrent);
  h.journalStore.create({
    version: 1,
    status: 'active',
    entries: [{ slug: 'first', templateId: 1, phase: 'applied', before, written }],
  });

  await assert.rejects(
    recoverMigrationJournal({ ...h, log: () => {} }),
    /live state no longer equals this migration written version; refusing concurrent edit/,
  );
  assert.deepEqual(h.live.get(1), concurrent);
  assert.equal(h.writes.length, 0);
  assert.equal(h.journalStore.exists(), true);
});

test('successful transaction commits all writes and leaves no journal', async (t) => {
  const items = [item(1, 'first'), item(2, 'second')];
  const h = harness(t, items);
  await runMigrationTransaction(items, { ...h, log: () => {} });

  assert.equal(h.live.get(1).schema[0].attachment_uuid, 'new-1');
  assert.equal(h.live.get(2).schema[0].attachment_uuid, 'new-2');
  assert.equal(h.journalStore.exists(), false);
  assert.equal(h.writes.length, 2);
});

test('transaction fails before journal or upload without provider CAS', async (t) => {
  const items = [item(1, 'first')];
  const h = harness(t, items);
  let uploads = 0;
  await assert.rejects(
    runMigrationTransaction(items, {
      ...h,
      conditionalWriteTemplate: undefined,
      uploadPdf: async () => { uploads += 1; },
      log: () => {},
    }),
    /requires a provider-backed atomic conditional mutation/,
  );
  assert.equal(uploads, 0);
  assert.equal(h.journalStore.exists(), false);
});

test('live stale lock with matching process start identity refuses a second owner', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'esign-migration-live-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const store = createFileJournalStore(path, lockOptions(() => ({
    state: 'alive', startIdentity: 'test-start-1',
  })));
  seedLock(store, lockMetadata());
  const before = readFileSync(store.lockPath, 'utf8');

  assert.throws(() => store.acquireLock(), /owner process is still live/);
  assert.equal(readFileSync(store.lockPath, 'utf8'), before);
});

test('foreign, malformed, and uncertain stale locks are never reclaimed', async (t) => {
  const cases = [
    {
      name: 'foreign workflow',
      raw: `${JSON.stringify(lockMetadata({ workflowId: 'other-migration-workflow' }))}\n`,
      inspect: () => ({ state: 'dead', startIdentity: null }),
      error: /different workflow/,
    },
    {
      name: 'malformed metadata',
      raw: '{not-json\n',
      inspect: () => ({ state: 'dead', startIdentity: null }),
      error: /metadata is malformed or unsupported/,
    },
    {
      name: 'uncertain liveness',
      raw: `${JSON.stringify(lockMetadata())}\n`,
      inspect: () => ({ state: 'uncertain', startIdentity: null }),
      error: /liveness is uncertain/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const directory = mkdtempSync(join(tmpdir(), 'esign-migration-refuse-lock-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const store = createFileJournalStore(join(directory, 'journal.json'), lockOptions(entry.inspect));
      writeFileSync(store.lockPath, entry.raw, 'utf8');
      assert.throws(() => store.acquireLock(), entry.error);
      assert.equal(readFileSync(store.lockPath, 'utf8'), entry.raw);
    });
  }
});

test('PID reuse start-identity mismatch reclaims a dead original owner', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'esign-migration-pid-reuse-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createFileJournalStore(
    join(directory, 'journal.json'),
    lockOptions(() => ({ state: 'alive', startIdentity: 'reused-pid-new-start' })),
  );
  seedLock(store, lockMetadata({ processStartIdentity: 'original-owner-start' }));

  const acquired = store.acquireLock();
  assert.equal(acquired.reclaimed, true);
  const owner = JSON.parse(readFileSync(store.lockPath, 'utf8'));
  assert.equal(owner.pid, 7777);
  assert.equal(owner.workflowId, GENERATED_MIGRATION_WORKFLOW_ID);
  assert.equal(owner.token, 'new-owner-token-0002');
  assert.equal(owner.host, 'test-host');
  assert.equal(owner.processStartIdentity, 'test-start-new');
  store.releaseLock();
});

test('IIPP migration uses the shared ownership metadata lock', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'esign-iipp-migration-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'iipp.lock');
  const lock = createIippMigrationProcessLock({
    path,
    ...lockOptions(() => ({ state: 'dead', startIdentity: null })),
  });

  lock.acquire();
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(owner.workflowId, IIPP_MIGRATION_WORKFLOW_ID);
  assert.equal(owner.token, 'new-owner-token-0002');
  assert.equal(owner.processStartedAt, '2026-07-30T11:59:00.000Z');
  lock.release();
});

test('journal creation and process lock are atomically exclusive', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'esign-migration-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const first = createFileJournalStore(path);
  const second = createFileJournalStore(path);

  first.acquireLock();
  assert.throws(() => second.acquireLock(), /another migration process holds the exclusive lock/);
  first.releaseLock();

  first.create({ version: 1, status: 'active', entries: [] });
  assert.throws(
    () => second.create({ version: 1, status: 'active', entries: [] }),
    /unresolved migration journal already exists/,
  );
});
