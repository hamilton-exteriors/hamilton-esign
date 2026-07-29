// Guarded in-place refresh of all registered template PDFs and field geometry.
// Existing template IDs, submitter roles, field UUIDs, and bearer links survive.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BUILD_DIR, loadDocusealSecrets } from './config.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { TEMPLATE_REGISTRY, requireUniqueActiveTemplate } from './registry.mjs';
import { createAdminSession } from './migrate-iipp.mjs';

const apply = process.argv.includes('--apply');
const slugFlag = process.argv.find((value) => value.startsWith('--slug='));
const slugIndex = process.argv.indexOf('--slug');
const requestedSlug = slugFlag?.slice('--slug='.length) || (slugIndex >= 0 ? process.argv[slugIndex + 1] : '');
if (slugIndex >= 0 && (!requestedSlug || requestedSlug.startsWith('--'))) {
  throw new Error('--slug requires a document slug');
}
const registry = requestedSlug
  ? TEMPLATE_REGISTRY.filter((entry) => entry.slug === requestedSlug)
  : TEMPLATE_REGISTRY;
if (!registry.length) throw new Error(`unknown document slug: ${requestedSlug}`);
const secrets = loadDocusealSecrets();
const client = createDocusealClient(secrets);
const generatedDocuments = JSON.parse(readFileSync(`${BUILD_DIR}/fields.json`, 'utf8'));
const generatedBySlug = new Map(generatedDocuments.map((document) => [document.slug, document]));
const inventory = await client.listAll('/api/templates', { what: 'template inventory' });

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

const plans = [];
for (const entry of registry) {
  const summary = requireUniqueActiveTemplate(inventory, entry.title);
  const template = await client.request(`/api/templates/${summary.id}`, {}, `template ${summary.id}`);
  const generated = generatedBySlug.get(entry.slug);
  if (!generated) throw new Error(`${entry.slug} is missing from fields.json`);
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
const active = submissions.filter((submission) => !submission.archived_at &&
  templateIds.has(submission.template?.id || submission.template_id));
for (const submission of active) {
  const full = await client.request(`/api/submissions/${submission.id}`, {}, `submission ${submission.id}`);
  if (Object.hasOwn(full, 'template_fields') || Object.hasOwn(full, 'template_schema')) {
    throw new Error(`submission ${submission.id} contains a frozen template snapshot; refusing refresh`);
  }
}

for (const { entry, template, plan, pdfCurrent, schemaCurrent } of plans) {
  const detail = [...plan.changes, ...(pdfCurrent ? [] : ['PDF/footer']), ...(schemaCurrent ? [] : ['source filename'])].join(', ') || 'current';
  console.log(`${String(template.id).padStart(3)} ${entry.slug.padEnd(34)} ${detail}`);
}
console.log(`active submissions checked: ${active.length}`);
if (!apply) {
  console.log('dry run only; re-run with --apply');
  process.exit(0);
}

const admin = createAdminSession(secrets);
await admin.signIn();
for (const item of plans) {
  const { entry, template, generated, plan, pdf, pdfCurrent, schemaCurrent } = item;
  if (pdfCurrent && schemaCurrent && plan.changes.length === 0) {
    console.log(`skip ${entry.slug}: already current`);
    continue;
  }
  const uploaded = await admin.uploadPdf(template.id, pdf, `${entry.slug}.pdf`);
  const attachmentUuid = uploaded.schema[0].attachment_uuid;
  const fields = buildRefreshedFields(template, plan.targetByUuid, attachmentUuid);
  let saved = false;
  try {
    await admin.save(template.id, uploaded.csrf, uploaded.schema, template.submitters, fields);
    saved = true;
    const after = await client.request(`/api/templates/${template.id}`, {}, `refreshed ${entry.slug}`);
    assertPostflight(template, after, plan, attachmentUuid);
    console.log(`updated ${entry.slug} in place`);
  } catch (error) {
    if (saved) {
      await admin.save(template.id, uploaded.csrf, template.schema, template.submitters, template.fields);
      const restored = await client.request(`/api/templates/${template.id}`, {}, `rolled back ${entry.slug}`);
      if (restored.schema?.[0]?.attachment_uuid !== template.schema[0].attachment_uuid) {
        throw new Error(`${entry.slug} failed postflight (${error.message}); rollback failed`);
      }
    }
    throw error;
  }
}
