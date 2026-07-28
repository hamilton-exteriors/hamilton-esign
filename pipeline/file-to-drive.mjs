// File a fully completed Hamilton e-sign submission into Google Drive using
// immutable DocuSeal identities, not a collision-prone person/template/day name.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { safeName, driveQuote } from './safe.mjs';
import { createDocusealClient } from './docuseal-api.mjs';

const client = createDocusealClient();
const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
  join(homedir(), '.claude', 'skills', 'gmail', 'config', 'google-service-account.json');
const ROOT = 'Hamilton Employee Records';

const ROUTE = [
  [/i-?9|employment eligibility|elegibilidad de empleo/i, 'i9'],
  [/predesignation|physician|medical|dwc|predesignaci|m[ée]dico/i, 'medical'],
  [/safety training roster|registro de capacitaci/i, 'safety-roster'],
  [/iipp|injury and illness|heat illness|fall protection|code of safe/i, 'program'],
  [/prevenci[óo]n de (enfermedades|lesiones)|por calor|protecci[óo]n contra ca[íi]das|pr[áa]cticas seguras/i, 'program'],
  [/.*/, 'personnel'],
];
const bucketFor = (name) => ROUTE.find(([pattern]) => pattern.test(name))[1];

async function drive() {
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
    subject: 'admin@hamilton-exteriors.com',
  });
  await auth.authorize();
  return google.drive({ version: 'v3', auth });
}

const esc = driveQuote;

async function folder(clientDrive, name, parentId) {
  const query = [
    `name='${esc(name)}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ');
  const found = await clientDrive.files.list({ q: query, fields: 'files(id,name)', pageSize: 1 });
  if (found.data.files?.length) return found.data.files[0].id;
  const created = await clientDrive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId || 'root'] },
    fields: 'id',
  });
  if (!created.data.id) throw new Error(`Drive did not return an id for folder ${name}`);
  return created.data.id;
}

async function destination(clientDrive, bucket, person) {
  const root = await folder(clientDrive, ROOT);
  if (bucket === 'program') {
    const safety = await folder(clientDrive, 'Safety', root);
    return folder(clientDrive, 'Programs', safety);
  }
  if (bucket === 'safety-roster') {
    const safety = await folder(clientDrive, 'Safety', root);
    const rosters = await folder(clientDrive, 'Training Rosters', safety);
    return folder(clientDrive, person, rosters);
  }
  const employees = await folder(clientDrive, 'Employees', root);
  const employee = await folder(clientDrive, person, employees);
  return folder(clientDrive, { personnel: 'Personnel', i9: 'I-9', medical: 'Medical' }[bucket], employee);
}

export function driveIdentity(submissionId, documentId) {
  if (submissionId == null || documentId == null) throw new Error('submission and document ids are required');
  return {
    docusealSubmissionId: String(submissionId),
    docusealDocumentId: String(documentId),
  };
}

export async function fileSubmission(submissionId) {
  if (!Number.isInteger(Number(submissionId)) || Number(submissionId) <= 0) {
    throw new Error('submission id must be a positive integer');
  }
  const submission = await client.request(`/api/submissions/${submissionId}`, {}, `submission ${submissionId}`);
  if (submission.archived_at) throw new Error(`submission ${submissionId} is archived`);
  const submitters = submission.submitters || [];
  if (!submitters.length) throw new Error(`submission ${submissionId} has no submitters`);
  const pending = submitters.filter((submitter) => !submitter.completed_at);
  if (pending.length) {
    throw new Error(`submission ${submissionId} is incomplete; waiting on ${pending.map((entry) => entry.name).join(', ')}`);
  }
  const documents = await client.request(`/api/submissions/${submissionId}/documents`, {},
    `documents for submission ${submissionId}`);
  if (!documents.documents?.length) throw new Error(`submission ${submissionId} has no signed documents`);

  const clientDrive = await drive();
  const templateName = submission.template?.name || documents.documents[0]?.name || 'document';
  const bucket = bucketFor(templateName);
  const signer = submitters.find((entry) => /worker|employee/i.test(entry.role || '')) || submitters[0];
  const person = safeName(signer?.name, 'Unassigned');
  const date = (submission.completed_at || submitters[0].completed_at || '').slice(0, 10) || 'signed';
  const output = [];

  for (const document of documents.documents) {
    const parent = await destination(clientDrive, bucket, person);
    const identity = driveIdentity(submissionId, document.id);
    const duplicate = await clientDrive.files.list({
      q: `appProperties has { key='docusealSubmissionId' and value='${esc(identity.docusealSubmissionId)}' } and ` +
        `appProperties has { key='docusealDocumentId' and value='${esc(identity.docusealDocumentId)}' } and trashed=false`,
      fields: 'files(id,name,webViewLink)',
      pageSize: 1,
    });
    if (duplicate.data.files?.length) {
      output.push({ bucket, person, file: duplicate.data.files[0].name,
        link: duplicate.data.files[0].webViewLink, skipped: true });
      continue;
    }

    const filename = `${safeName(templateName, 'Document')} - ${person} - ${date} - S${submissionId}-D${document.id}.pdf`;
    const response = await fetch(document.url);
    if (!response.ok) throw new Error(`signed PDF ${document.id} returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error(`signed PDF ${document.id} was empty`);
    const created = await clientDrive.files.create({
      requestBody: { name: filename, parents: [parent], appProperties: identity },
      media: { mimeType: 'application/pdf', body: Readable.from(bytes) },
      fields: 'id,name,webViewLink',
    });
    if (!created.data.id) throw new Error(`Drive did not return an id for ${filename}`);
    output.push({ bucket, person, file: created.data.name, link: created.data.webViewLink });
  }
  return output;
}

export async function sweep() {
  const submissions = await client.listAll('/api/submissions', { what: 'submission inventory' });
  const complete = submissions
    .filter((submission) => !submission.archived_at)
    .filter((submission) => {
      const submitters = submission.submitters || [];
      return submitters.length > 0 && submitters.every((entry) => entry.completed_at);
    });
  const results = [];
  for (const submission of complete) {
    try { results.push(...await fileSubmission(submission.id)); }
    catch (error) { results.push({ error: `submission ${submission.id}: ${error.message}` }); }
  }
  return { completed: complete.length, results };
}

const IS_MAIN = Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (IS_MAIN) {
  const argument = process.argv[2];
  if (argument === 'sweep') {
    const result = await sweep();
    console.log(`completed submissions: ${result.completed}`);
    for (const entry of result.results) {
      console.log(entry.error ? `  ERROR ${entry.error}`
        : `  ${entry.skipped ? 'already filed' : 'FILED'} [${entry.bucket}] ${entry.person} - ${entry.file}`);
    }
    if (result.results.some((entry) => entry.error)) process.exitCode = 1;
  } else if (/^\d+$/.test(argument || '')) {
    for (const result of await fileSubmission(Number(argument))) {
      console.log(`${result.skipped ? 'already filed' : 'filed'} [${result.bucket}] ${result.person}\n   ${result.file}\n   ${result.link || ''}`);
    }
  } else {
    console.error('usage: node file-to-drive.mjs <submissionId|sweep>');
    process.exit(1);
  }
}
