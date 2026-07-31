// Guarded in-place refresh of current composite template PDFs and field geometry.
// Existing template IDs, submitter roles, field UUIDs, and bearer links survive.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_DIR, DOCS_DIR, loadDocusealSecrets } from './config.mjs';
import { validateMeasuredBuild } from './build-manifest.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { CURRENT_TEMPLATE_REGISTRY, requireUniqueActiveTemplate } from './registry.mjs';
import {
  assertNoBlockingSubmissions,
  createExclusiveFile,
  DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES,
  requireProviderConditionalMutation,
} from './template-mutation-safety.mjs';
import { createMigrationProcessLock } from './migration-process-lock.mjs';

const JOURNAL_VERSION = 1;
export const GENERATED_MIGRATION_WORKFLOW_ID = 'generated-composite-template-migration';
const DEFAULT_JOURNAL_PATH = join(
  homedir(), '.claude', '.hamilton-state', 'template-migrations', 'generated-composites.json',
);
const USAGE = 'usage: node pipeline/migrate-generated-templates.mjs [--slug <composite-slug>] [--apply]';

export function parseMigrationArgs(argv) {
  let apply = false;
  let slug = '';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') {
      if (apply) throw new Error(`${USAGE} (duplicate --apply)`);
      apply = true;
      continue;
    }
    if (value === '--slug') {
      if (slug) throw new Error(`${USAGE} (duplicate --slug)`);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--slug requires a document slug');
      slug = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--slug=')) {
      if (slug) throw new Error(`${USAGE} (duplicate --slug)`);
      slug = value.slice('--slug='.length);
      if (!slug) throw new Error('--slug requires a document slug');
      continue;
    }
    throw new Error(USAGE);
  }
  return { apply, requestedSlug: slug };
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    // Windows does not consistently allow directory handles. The journal file
    // itself is still fsynced before its atomic rename.
    if (!['EACCES', 'EINVAL', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createFileJournalStore(
  path = process.env.HAMILTON_TEMPLATE_MIGRATION_JOURNAL || DEFAULT_JOURNAL_PATH,
  lockOptions = {},
) {
  const lockPath = `${path}.lock`;
  const processLock = createMigrationProcessLock({
    path: lockPath,
    workflowId: GENERATED_MIGRATION_WORKFLOW_ID,
    ...lockOptions,
  });
  let lockHeld = false;
  return {
    path,
    lockPath,
    exists: () => existsSync(path),
    acquireLock() {
      mkdirSync(dirname(path), { recursive: true });
      const result = processLock.acquire();
      lockHeld = true;
      syncDirectory(dirname(path));
      return result;
    },
    releaseLock() {
      if (!lockHeld) return;
      processLock.release();
      lockHeld = false;
      syncDirectory(dirname(path));
    },
    load() {
      if (!existsSync(path)) return null;
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      if (journal.version !== JOURNAL_VERSION || !Array.isArray(journal.entries)) {
        throw new Error(`unsupported or corrupt migration journal at ${path}`);
      }
      return journal;
    },
    create(journal) {
      mkdirSync(dirname(path), { recursive: true });
      try {
        createExclusiveFile(path, `${JSON.stringify(journal, null, 2)}\n`);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('an unresolved migration journal already exists; recover it first');
        throw error;
      }
      syncDirectory(dirname(path));
    },
    save(journal) {
      if (!existsSync(path)) throw new Error(`cannot update missing migration journal at ${path}`);
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      let fd;
      try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
        fsyncSync(fd);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      renameSync(temporary, path);
      syncDirectory(dirname(path));
    },
    remove() {
      rmSync(path, { force: true });
      if (existsSync(dirname(path))) syncDirectory(dirname(path));
    },
  };
}

export function guardedTemplateState(template) {
  return {
    id: template.id,
    name: template.name,
    schema: template.schema,
    submitters: template.submitters,
    fields: template.fields,
  };
}

const sameState = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const clone = (value) => JSON.parse(JSON.stringify(value));

async function rollbackJournal(journal, { journalStore, readTemplate, conditionalWriteTemplate, log = console.log }) {
  const errors = [];
  for (const entry of [...journal.entries].reverse()) {
    if (entry.phase === 'rolled-back') continue;
    if (entry.phase === 'prepared') {
      entry.phase = 'rolled-back';
      journalStore.save(journal);
      continue;
    }
    try {
      const live = guardedTemplateState(await readTemplate(entry.templateId, `rollback check ${entry.slug}`));
      if (sameState(live, entry.before)) {
        entry.phase = 'rolled-back';
        journalStore.save(journal);
        continue;
      }
      if (!sameState(live, entry.written)) {
        throw new Error('live state no longer equals this migration written version; refusing concurrent edit');
      }
      try {
        await conditionalWriteTemplate(entry.templateId, entry.written, entry.before, `rollback ${entry.slug}`);
      } catch (writeError) {
        const reconciled = guardedTemplateState(
          await readTemplate(entry.templateId, `reconcile rollback ${entry.slug}`),
        );
        if (!sameState(reconciled, entry.before)) throw writeError;
      }
      const restored = guardedTemplateState(await readTemplate(entry.templateId, `verify rollback ${entry.slug}`));
      if (!sameState(restored, entry.before)) throw new Error('rollback did not restore the exact guarded state');
      entry.phase = 'rolled-back';
      journalStore.save(journal);
      log(`rolled back ${entry.slug}`);
    } catch (error) {
      errors.push(`${entry.slug}: ${error.message}`);
    }
  }
  if (errors.length) {
    throw new Error(`rollback incomplete; journal retained: ${errors.join('; ')}`);
  }
  journalStore.remove();
}

export async function recoverMigrationJournal(options) {
  const { journalStore } = options;
  journalStore.acquireLock();
  try {
    const journal = journalStore.load();
    if (!journal) return false;
    if (journal.status === 'committed') {
      journalStore.remove();
      options.log?.('removed committed migration journal');
      return true;
    }
    if (journal.status !== 'active') throw new Error(`unknown migration journal status: ${journal.status}`);
    await rollbackJournal(journal, options);
    return true;
  } finally {
    journalStore.releaseLock();
  }
}

export async function runMigrationTransaction(items, options) {
  const { journalStore, readTemplate, uploadPdf, conditionalWriteTemplate, log = console.log } = options;
  if (typeof conditionalWriteTemplate !== 'function') {
    throw new Error('in-place migration requires a provider-backed atomic conditional mutation');
  }
  journalStore.acquireLock();
  try {
    const journal = {
      version: JOURNAL_VERSION,
      status: 'active',
      startedAt: new Date().toISOString(),
      entries: [],
    };
    journalStore.create(journal);
    try {
    for (const item of items) {
      const { entry, template, plan, pdf } = item;
      const before = guardedTemplateState(template);
      const immediatelyBefore = guardedTemplateState(
        await readTemplate(template.id, `pre-upload ${entry.slug}`),
      );
      if (!sameState(immediatelyBefore, before)) {
        throw new Error(`${entry.slug}: template changed after planning; refusing concurrent edit`);
      }

      const uploaded = await uploadPdf(template.id, pdf, `${entry.slug}.pdf`);
      const attachmentUuid = uploaded.schema[0].attachment_uuid;
      const fields = buildRefreshedFields(template, plan.targetByUuid, attachmentUuid);
      const written = guardedTemplateState({
        ...template,
        schema: uploaded.schema,
        submitters: template.submitters,
        fields,
      });
      const journalEntry = {
        slug: entry.slug,
        templateId: template.id,
        phase: 'prepared',
        before: clone(before),
        written: clone(written),
      };
      journal.entries.push(journalEntry);
      journalStore.save(journal);

      const prewrite = guardedTemplateState(await readTemplate(template.id, `pre-write ${entry.slug}`));
      if (!sameState(prewrite, before)) {
        throw new Error(`${entry.slug}: template changed before write; refusing concurrent edit`);
      }
      journalEntry.phase = 'writing';
      journalStore.save(journal);
      try {
        await conditionalWriteTemplate(template.id, before, written, `write ${entry.slug}`, uploaded.csrf);
      } catch (writeError) {
        const reconciled = guardedTemplateState(
          await readTemplate(template.id, `reconcile uncertain write ${entry.slug}`),
        );
        if (sameState(reconciled, written)) journalEntry.phase = 'applied';
        else if (sameState(reconciled, before)) journalEntry.phase = 'writing';
        else journalEntry.phase = 'conflict';
        journalStore.save(journal);
        throw writeError;
      }

      const after = await readTemplate(template.id, `postflight ${entry.slug}`);
      if (!sameState(guardedTemplateState(after), written)) {
        throw new Error(`${entry.slug}: postflight state differs from the exact written version`);
      }
      journalEntry.phase = 'applied';
      journalStore.save(journal);
      assertPostflight(template, after, plan, attachmentUuid);
      log(`updated ${entry.slug} in place`);
    }
    journal.status = 'committed';
    journal.committedAt = new Date().toISOString();
    journalStore.save(journal);
    journalStore.remove();
    } catch (error) {
      try {
        await rollbackJournal(journal, { journalStore, readTemplate, conditionalWriteTemplate, log });
      } catch (rollbackError) {
        throw new Error(`migration failed (${error.message}); ${rollbackError.message}`);
      }
      throw new Error(`migration failed and all possible mutations were rolled back: ${error.message}`);
    }
  } finally {
    journalStore.releaseLock();
  }
}

const TYPE_EXCEPTIONS = new Set([
  'iipp:Administrator phone',
  'iipp:Reviewed / updated',
]);
const geometry = ({ page, x, y, w, h }) => ({ page, x, y, w, h });
const areaGeometry = (area) => geometry(area);
const sameGeometry = (left, right) => ['page', 'x', 'y', 'w', 'h'].every((key) => left[key] === right[key]);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function ownerFor(field, submitters) {
  const role = submitters.find((submitter) => submitter.uuid === field.submitter_uuid)?.name || '';
  if (/worker/i.test(role)) return 'worker';
  if (/hamilton/i.test(role)) return 'employer';
  throw new Error(`${field.name} has an unknown submitter role`);
}

function expectedLiveNames(fields) {
  const totals = {};
  const indexes = {};
  const seen = new Map();
  for (const field of fields) totals[field.owner] = (totals[field.owner] || 0) + 1;
  return new Map(fields.map((field) => {
    indexes[field.owner] = (indexes[field.owner] || 0) + 1;
    const prefix = totals[field.owner] >= 8 ? `${indexes[field.owner]}/${totals[field.owner]} ` : '';
    let short = field.name;
    if (short.length > 46) {
      const cut = short.slice(0, 46);
      const space = cut.lastIndexOf(' ');
      short = (space > 27.6 ? cut.slice(0, space) : cut).replace(/[\s(,;:-]+$/, '') + '…';
    }
    let name = `${prefix}${short}`;
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    if (count > 1) name = `${name} (${count})`;
    return [field.id, name];
  }));
}

export function planTemplateRefresh(entry, template, generated) {
  if (template.name !== entry.title || generated.slug !== entry.slug) throw new Error(`${entry.slug} identity changed`);
  if ((template.schema || []).length !== 1 || (template.documents || []).length !== 1) {
    throw new Error(`${entry.slug} must have exactly one source document`);
  }
  if ((template.fields || []).length !== entry.fields || generated.fields?.length !== entry.fields) {
    throw new Error(`${entry.slug} field count changed`);
  }
  const liveByUuid = new Map(template.fields.map((field) => [field.uuid, field]));
  if (liveByUuid.size !== entry.fields || liveByUuid.has(undefined)) throw new Error(`${entry.slug} has invalid field UUIDs`);
  const used = new Set();
  const targetByUuid = new Map();
  const changes = [];

  const names = expectedLiveNames(generated.fields);
  for (const target of generated.fields) {
    const expectedName = names.get(target.id);
    const candidates = template.fields.filter((live) => !used.has(live.uuid) &&
      live.name === expectedName && ownerFor(live, template.submitters || []) === target.owner);
    if (candidates.length !== 1) {
      throw new Error(`${entry.slug}:${target.name} has ${candidates.length} guarded live matches`);
    }
    const live = candidates[0];
    if (live.areas?.length !== 1) throw new Error(`${entry.slug}:${target.name} area count changed`);

    const oldArea = areaGeometry(live.areas[0]);
    const nextArea = geometry(target);
    if (!sameGeometry(oldArea, nextArea)) changes.push(`${target.name} geometry`);
    if (live.type !== target.type) {
      if (!TYPE_EXCEPTIONS.has(`${entry.slug}:${target.name}`)) {
        throw new Error(`${entry.slug}:${target.name} type changed outside the allowlist`);
      }
      changes.push(`${target.name} ${live.type}->${target.type}`);
    }
    used.add(live.uuid);
    targetByUuid.set(live.uuid, target);
  }
  if (used.size !== entry.fields) throw new Error(`${entry.slug} did not match every live field`);
  return { changes, targetByUuid };
}

export function buildRefreshedFields(template, targetByUuid, attachmentUuid) {
  return template.fields.map((live) => {
    const target = targetByUuid.get(live.uuid);
    if (!target) throw new Error(`missing target for live field ${live.uuid}`);
    return { ...live, type: target.type, areas: [{ ...geometry(target), attachment_uuid: attachmentUuid }] };
  });
}

function assertPostflight(before, after, plan, attachmentUuid) {
  if (before.id !== after.id || before.name !== after.name) throw new Error('template identity changed');
  if (JSON.stringify(before.submitters) !== JSON.stringify(after.submitters)) throw new Error('submitters changed');
  const beforeUuids = before.fields.map((field) => field.uuid).sort();
  const afterUuids = after.fields.map((field) => field.uuid).sort();
  if (JSON.stringify(beforeUuids) !== JSON.stringify(afterUuids)) throw new Error('field UUID set changed');
  if (after.schema?.[0]?.attachment_uuid !== attachmentUuid) throw new Error('attachment schema did not update');
  for (const live of after.fields) {
    const target = plan.targetByUuid.get(live.uuid);
    if (!target || live.type !== target.type || !sameGeometry(areaGeometry(live.areas?.[0] || {}), geometry(target))) {
      throw new Error(`${live.name} failed postflight`);
    }
  }
}

async function run() {
  const { apply, requestedSlug } = parseMigrationArgs(process.argv.slice(2));
  if (apply) requireProviderConditionalMutation(DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES);
  const compositeRegistry = CURRENT_TEMPLATE_REGISTRY.filter((entry) => (entry.sources || []).length > 1);
  const registry = requestedSlug
    ? compositeRegistry.filter((entry) => entry.slug === requestedSlug)
    : compositeRegistry;
  if (!registry.length) throw new Error(`unknown current composite document slug: ${requestedSlug}`);

  const journalStore = createFileJournalStore();
  if (!apply && journalStore.exists()) {
    throw new Error(`unfinished apply journal at ${journalStore.path}; re-run with --apply to recover safely`);
  }

  let client;
  const getClient = () => {
    if (!client) client = createDocusealClient(loadDocusealSecrets());
    return client;
  };
  const readTemplate = (id, what) => getClient().request(`/api/templates/${id}`, {}, what);

  const generatedDocuments = JSON.parse(readFileSync(`${BUILD_DIR}/fields.json`, 'utf8'));
  const generatedBySlug = new Map(generatedDocuments.map((document) => [document.slug, document]));
  for (const entry of registry) {
    const generated = generatedBySlug.get(entry.slug);
    if (!generated) throw new Error(`${entry.slug} is missing from fields.json`);
    validateMeasuredBuild(generated, entry, DOCS_DIR, BUILD_DIR, readFileSync(`${BUILD_DIR}/${entry.slug}.pdf`));
  }

  // Normal planning network access remains below complete local artifact validation.
  const remoteClient = getClient();
  const inventory = await remoteClient.listAll('/api/templates', { what: 'template inventory' });
  const plans = [];
  for (const entry of registry) {
    const summary = requireUniqueActiveTemplate(inventory, entry.title);
    const template = await readTemplate(summary.id, `template ${summary.id}`);
    const generated = generatedBySlug.get(entry.slug);
    const plan = planTemplateRefresh(entry, template, generated);
    const pdf = readFileSync(`${BUILD_DIR}/${entry.slug}.pdf`);
    const response = await fetch(template.documents[0].url);
    if (!response.ok) throw new Error(`${entry.slug} source PDF returned ${response.status}`);
    const sourcePdf = Buffer.from(await response.arrayBuffer());
    const pdfCurrent = digest(pdf) === digest(sourcePdf);
    const schemaCurrent = template.schema[0].name === entry.slug;
    plans.push({ entry, template, generated, plan, pdf, pdfCurrent, schemaCurrent });
  }

  const submissions = await client.listAll('/api/submissions', { what: 'submission inventory' });
  const templateIds = new Set(plans.map(({ template }) => template.id));
  await assertNoBlockingSubmissions({
    submissions,
    targetTemplateIds: templateIds,
    readSubmission: (id) => client.request(`/api/submissions/${id}`, {}, `submission ${id}`),
  });

  for (const { entry, template, plan, pdfCurrent, schemaCurrent } of plans) {
    const detail = [...plan.changes, ...(pdfCurrent ? [] : ['PDF/footer']), ...(schemaCurrent ? [] : ['source filename'])].join(', ') || 'current';
    console.log(`${String(template.id).padStart(3)} ${entry.slug.padEnd(34)} ${detail}`);
  }
  console.log(`submission inventory safety-checked: ${submissions.length}`);
  if (!apply) {
    console.log('dry run only; re-run with --apply');
    return;
  }

  // This branch is intentionally unreachable while DocuSeal lacks a provider-side
  // conditional template mutation. Read/compare/local journals cannot close the
  // race between the final read and PUT, so --apply fails before any live call.
  requireProviderConditionalMutation(DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await run();
