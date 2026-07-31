// Guarded, in-place migration for the one active IIPP template. This utility
// never creates, archives, clones, or replaces a template or submission.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_DIR, loadDocusealSecrets } from './config.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { TEMPLATE_BY_SLUG, requireUniqueActiveTemplate } from './registry.mjs';
import {
  assertNoBlockingSubmissions,
  DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES,
  requireProviderConditionalMutation,
} from './template-mutation-safety.mjs';

import { createMigrationProcessLock } from './migration-process-lock.mjs';

const SLUG = 'iipp';
export const IIPP_MIGRATION_WORKFLOW_ID = 'iipp-template-migration';
const DEFAULT_IIPP_LOCK_PATH = join(
  homedir(), '.claude', '.hamilton-state', 'template-migrations', 'iipp.lock',
);

export function createIippMigrationProcessLock(options = {}) {
  return createMigrationProcessLock({
    path: process.env.HAMILTON_IIPP_MIGRATION_LOCK || DEFAULT_IIPP_LOCK_PATH,
    workflowId: IIPP_MIGRATION_WORKFLOW_ID,
    ...options,
  });
}
const EXPECTED_TEMPLATE_ID = 360;
const EXPECTED_NAMES = [
  'Effective date',
  'Administrator phone',
  'Reviewed / updated',
  'Signature',
  'Date',
];
const CURRENT_TYPES = new Map([
  ['Effective date', 'date'],
  ['Administrator phone', 'phone'],
  ['Reviewed / updated', 'text'],
  ['Signature', 'signature'],
  ['Date', 'date'],
]);
const CHANGEABLE_GEOMETRY = new Set([
  'Effective date',
  'Administrator phone',
  'Reviewed / updated',
]);

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const areaGeometry = ({ attachment_uuid: _attachment, ...area }) => area;
const generatedGeometry = ({ page, x, y, w, h }) => ({ page, x, y, w, h });
const sameGeometry = (left, right) => ['page', 'x', 'y', 'w', 'h'].every((key) => left[key] === right[key]);

function uniqueByName(fields, context) {
  const byName = new Map();
  for (const field of fields || []) {
    if (!field?.name || byName.has(field.name)) {
      throw new Error(`${context} has a missing or duplicate field name: ${field?.name || '(missing)'}`);
    }
    byName.set(field.name, field);
  }
  if (!same([...byName.keys()].sort(), [...EXPECTED_NAMES].sort())) {
    throw new Error(`${context} field names do not match the guarded IIPP baseline`);
  }
  return byName;
}

export function planIippMigration(template, generated) {
  if (template.id !== EXPECTED_TEMPLATE_ID) {
    throw new Error(`refusing IIPP template ${template.id}; expected ${EXPECTED_TEMPLATE_ID}`);
  }
  if (template.name !== TEMPLATE_BY_SLUG.get(SLUG).title) throw new Error('IIPP title changed');
  if ((template.schema || []).length !== 1) throw new Error('IIPP must have exactly one document schema');
  if ((template.submitters || []).length !== 1 || template.submitters[0].name !== 'Hamilton') {
    throw new Error('IIPP must have exactly one Hamilton submitter');
  }
  if ((template.fields || []).length !== EXPECTED_NAMES.length) throw new Error('IIPP must have five fields');
  if (new Set(template.fields.map((field) => field.uuid)).size !== EXPECTED_NAMES.length) {
    throw new Error('IIPP field UUIDs must be present and unique');
  }
  if (generated.slug !== SLUG || generated.fields?.length !== EXPECTED_NAMES.length) {
    throw new Error('generated IIPP artifact is missing or has the wrong field count');
  }

  const liveByName = uniqueByName(template.fields, 'live IIPP');
  const generatedByName = uniqueByName(generated.fields, 'generated IIPP');
  const roleUuid = template.submitters[0].uuid;
  const alreadyApplied = EXPECTED_NAMES.every((name) => {
    const live = liveByName.get(name);
    const target = generatedByName.get(name);
    return live.type === target.type && live.submitter_uuid === roleUuid &&
      live.areas?.length === 1 && sameGeometry(areaGeometry(live.areas[0]), generatedGeometry(target));
  });

  for (const name of EXPECTED_NAMES) {
    const live = liveByName.get(name);
    const target = generatedByName.get(name);
    if (live.submitter_uuid !== roleUuid || live.areas?.length !== 1) {
      throw new Error(`${name} changed owner or area count`);
    }
    if (!alreadyApplied && ![CURRENT_TYPES.get(name), target.type].includes(live.type)) {
      throw new Error(`${name} type is outside the guarded baseline or generated target`);
    }
    if (target.owner !== 'employer') throw new Error(`${name} generated owner is not employer`);
    if (!CHANGEABLE_GEOMETRY.has(name) && !sameGeometry(areaGeometry(live.areas[0]), generatedGeometry(target))) {
      throw new Error(`${name} generated geometry changed unexpectedly`);
    }
    if (CHANGEABLE_GEOMETRY.has(name)) {
      const oldArea = areaGeometry(live.areas[0]);
      const nextArea = generatedGeometry(target);
      if (oldArea.page !== nextArea.page || oldArea.y !== nextArea.y || oldArea.h !== nextArea.h) {
        throw new Error(`${name} changed page or vertical geometry`);
      }
    }
  }

  const changes = EXPECTED_NAMES.flatMap((name) => {
    const live = liveByName.get(name);
    const target = generatedByName.get(name);
    const out = [];
    if (live.type !== target.type) out.push(`${name}: type ${live.type} -> ${target.type}`);
    const oldArea = areaGeometry(live.areas[0]);
    const nextArea = generatedGeometry(target);
    if (!sameGeometry(oldArea, nextArea)) out.push(`${name}: geometry ${oldArea.w} -> ${nextArea.w}`);
    return out;
  });

  return { alreadyApplied, changes, liveByName, generatedByName };
}

export function buildMigratedFields(template, generated, attachmentUuid) {
  const { liveByName, generatedByName } = planIippMigration(template, generated);
  return EXPECTED_NAMES.map((name) => {
    const live = liveByName.get(name);
    const target = generatedByName.get(name);
    return {
      ...live,
      type: target.type,
      areas: [{ ...generatedGeometry(target), attachment_uuid: attachmentUuid }],
    };
  });
}

export function assertIippPostflight(before, after, generated, attachmentUuid) {
  const planned = planIippMigration(after, generated);
  if (!planned.alreadyApplied) throw new Error('IIPP postflight does not match generated fields');
  if (after.id !== before.id || after.name !== before.name) throw new Error('IIPP identity changed');
  if (!same(after.submitters, before.submitters)) throw new Error('IIPP submitter schema changed');
  if (!same(after.fields.map((field) => field.uuid).sort(), before.fields.map((field) => field.uuid).sort())) {
    throw new Error('IIPP field UUID set changed');
  }
  if ((after.schema || [])[0]?.attachment_uuid !== attachmentUuid) {
    throw new Error('IIPP attachment did not update');
  }
}

export function createAdminSession(secrets, fetchImpl = fetch) {
  let cookie = '';
  const setCookie = (response) => {
    const values = response.headers.getSetCookie?.() || [];
    if (values.length) cookie = values.map((value) => value.split(';')[0]).join('; ');
  };
  const tokenFrom = (html, pattern) => {
    const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((match) => match[0]);
    const form = forms.find((value) => pattern.test(value)) || forms[0] || '';
    return (form.match(/name="authenticity_token"[^>]*value="([^"]*)"/) || [])[1];
  };
  return {
    async signIn() {
      let response = await fetchImpl(`${secrets.url}/sign_in`);
      setCookie(response);
      if (!response.ok) throw new Error(`sign-in page failed ${response.status}`);
      const token = tokenFrom(await response.text(), /sign_in/);
      if (!token) throw new Error('sign-in page returned no authenticity token');
      const body = new URLSearchParams({
        authenticity_token: token,
        'user[email]': secrets.email,
        'user[password]': secrets.password,
      });
      response = await fetchImpl(`${secrets.url}/sign_in`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });
      setCookie(response);
      if (![302, 303].includes(response.status)) throw new Error(`sign-in failed ${response.status}`);
    },
    async getCsrf(templateId) {
      const edit = await fetchImpl(`${secrets.url}/templates/${templateId}/edit`, { headers: { cookie } });
      setCookie(edit);
      if (!edit.ok) throw new Error(`IIPP edit page failed ${edit.status}`);
      const csrf = ((await edit.text()).match(/name="csrf-token" content="([^"]+)"/) || [])[1];
      if (!csrf) throw new Error('IIPP edit page returned no CSRF token');
      return csrf;
    },
    async uploadPdf(templateId, pdf, filename = 'iipp.pdf') {
      const csrf = await this.getCsrf(templateId);
      const body = new FormData();
      body.append('files[]', new Blob([pdf], { type: 'application/pdf' }), filename);
      const response = await fetchImpl(`${secrets.url}/templates/${templateId}/documents`, {
        method: 'POST', headers: { cookie, 'X-CSRF-Token': csrf, Accept: 'application/json' }, body,
      });
      setCookie(response);
      const text = await response.text();
      if (!response.ok) throw new Error(`IIPP upload failed ${response.status}: ${text.slice(0, 160)}`);
      const payload = JSON.parse(text);
      if (payload.schema?.length !== 1 || !payload.schema[0].attachment_uuid) {
        throw new Error('IIPP upload returned an invalid schema');
      }
      return { schema: payload.schema, csrf };
    },
    async save(templateId, csrf, schema, submitters, fields) {
      const response = await fetchImpl(`${secrets.url}/templates/${templateId}`, {
        method: 'PUT',
        headers: { cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ schema, submitters, fields }),
      });
      setCookie(response);
      const text = await response.text();
      if (!response.ok) throw new Error(`IIPP save failed ${response.status}: ${text.slice(0, 160)}`);
    },
  };
}

async function run() {
  const apply = process.argv.includes('--apply');
  let migrationLock;
  if (apply) {
    requireProviderConditionalMutation(DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES);
    migrationLock = createIippMigrationProcessLock();
    migrationLock.acquire();
  }
  try {
  const secrets = loadDocusealSecrets();
  const client = createDocusealClient(secrets);
  const documents = JSON.parse(readFileSync(`${BUILD_DIR}/fields.json`, 'utf8'));
  const generated = documents.find((document) => document.slug === SLUG);
  if (!generated) throw new Error('generated IIPP is missing; run build-docs and measure first');

  const inventory = await client.listAll('/api/templates', { what: 'template inventory' });
  const summary = requireUniqueActiveTemplate(inventory, TEMPLATE_BY_SLUG.get(SLUG).title);
  const before = await client.request(`/api/templates/${summary.id}`, {}, 'active IIPP template');
  const plan = planIippMigration(before, generated);

  const submissions = await client.listAll('/api/submissions', { what: 'submission inventory' });
  await assertNoBlockingSubmissions({
    submissions,
    targetTemplateIds: new Set([before.id]),
    readSubmission: (id) => client.request(`/api/submissions/${id}`, {}, `IIPP submission ${id}`),
  });

  console.log(`IIPP template ${before.id}: ${plan.alreadyApplied ? 'already current' : plan.changes.join('; ')}`);
  console.log(`submission inventory safety-checked: ${submissions.length}`);
  if (!apply) {
    console.log('dry run only; re-run with --apply');
    return;
  }
  // Deliberately unreachable until DocuSeal offers an atomic provider precondition.
  // A local rollback fingerprint cannot make an unconditional upload/PUT safe.
  requireProviderConditionalMutation(DOCUSEAL_TEMPLATE_MUTATION_CAPABILITIES);
  } finally {
    migrationLock?.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await run();
