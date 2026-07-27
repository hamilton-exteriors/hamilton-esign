// File a completed Hamilton e-sign submission into Google Drive.
//
// Routing is a LEGAL requirement, not tidiness: the I-9 and anything carrying a
// medical fact must live in physically separate files from the personnel file.
// Mixing them is its own violation, independent of what the documents say.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/admin/AppData/Roaming/npm/node_modules/');
const { google } = require('googleapis');

const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));
const KEY = JSON.parse(readFileSync('C:/Users/admin/.claude/skills/gmail/config/google-service-account.json', 'utf8'));

const ROOT = 'Hamilton Employee Records';

// template slug/name -> destination bucket
// Spanish titles must match too — the Spanish heat plan is a company program,
// and falling through to 'personnel' would file it in a worker's folder.
const ROUTE = [
  [/i-?9|employment eligibility|elegibilidad de empleo/i,   'i9'],
  [/predesignation|physician|medical|dwc|predesignaci|m[ée]dico/i, 'medical'],
  [/safety training roster|registro de capacitaci/i,        'safety-roster'],
  [/iipp|injury and illness|heat illness|fall protection|code of safe/i, 'program'],
  [/prevenci[óo]n de (enfermedades|lesiones)|por calor|protecci[óo]n contra ca[íi]das|pr[áa]cticas seguras/i, 'program'],
  [/.*/,                                                    'personnel'],
];
const bucketFor = (name) => ROUTE.find(([re]) => re.test(name))[1];

async function drive() {
  const auth = new google.auth.JWT({
    email: KEY.client_email, key: KEY.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
    subject: 'admin@hamilton-exteriors.com',
  });
  await auth.authorize();
  return google.drive({ version: 'v3', auth });
}

const esc = (s) => s.replace(/'/g, "\\'");

async function folder(d, name, parentId) {
  const q = [`name='${esc(name)}'`, "mimeType='application/vnd.google-apps.folder'",
    'trashed=false', parentId ? `'${parentId}' in parents` : "'root' in parents"].join(' and ');
  const found = await d.files.list({ q, fields: 'files(id,name)', pageSize: 1 });
  if (found.data.files?.length) return found.data.files[0].id;
  const made = await d.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId || 'root'] },
    fields: 'id',
  });
  return made.data.id;
}

/** Employees/<Name>/{personnel,i9,medical} + Safety/{training-rosters/<Name>,programs} */
async function destination(d, bucket, person) {
  const root = await folder(d, ROOT);
  if (bucket === 'program') {
    const safety = await folder(d, 'Safety', root);
    return folder(d, 'Programs', safety);
  }
  if (bucket === 'safety-roster') {
    const safety = await folder(d, 'Safety', root);
    const rosters = await folder(d, 'Training Rosters', safety);
    return folder(d, person, rosters);
  }
  const employees = await folder(d, 'Employees', root);
  const who = await folder(d, person, employees);
  return folder(d, { personnel: 'Personnel', i9: 'I-9', medical: 'Medical' }[bucket], who);
}

export async function fileSubmission(submissionId) {
  const d = await drive();
  const hdr = { 'X-Auth-Token': SEC.apiKey };
  const sub = await (await fetch(`${SEC.url}/api/submissions/${submissionId}`, { headers: hdr })).json();
  const docs = await (await fetch(`${SEC.url}/api/submissions/${submissionId}/documents`, { headers: hdr })).json();

  const tplName = sub.template?.name || docs.documents?.[0]?.name || 'document';
  const bucket = bucketFor(tplName);
  // the signer, not the countersigner, names the file
  const signer = (sub.submitters || []).find(s => /worker|employee/i.test(s.role || '')) || (sub.submitters || [])[0];
  const person = (signer?.name || 'Unassigned').replace(/[\\/:*?"<>|]/g, '').trim();

  const out = [];
  for (const doc of docs.documents || []) {
    const parent = await destination(d, bucket, person);
    const filename = `${tplName} - ${person} - ${(sub.completed_at || '').slice(0, 10) || 'draft'}.pdf`;
    // Idempotency: a re-run or a duplicate webhook must not create a second copy
    // of a signed employment record.
    const dupe = await d.files.list({
      q: `name='${esc(filename)}' and '${parent}' in parents and trashed=false`,
      fields: 'files(id,name,webViewLink)', pageSize: 1,
    });
    if (dupe.data.files?.length) {
      out.push({ bucket, person, file: filename, link: dupe.data.files[0].webViewLink, skipped: true });
      continue;
    }
    const bytes = Buffer.from(await (await fetch(doc.url)).arrayBuffer());
    const res = await d.files.create({
      requestBody: { name: filename, parents: [parent] },
      media: { mimeType: 'application/pdf', body: require('node:stream').Readable.from(bytes) },
      fields: 'id,name,webViewLink',
    });
    out.push({ bucket, person, file: res.data.name, link: res.data.webViewLink });
  }
  return out;
}

/** Sweep every completed submission and file anything not already in Drive.
 *  Idempotent by filename, so a missed webhook or a re-run costs nothing —
 *  which is why this is a sweep and not a webhook-only path. */
export async function sweep() {
  const hdr = { 'X-Auth-Token': SEC.apiKey };
  const list = await (await fetch(`${SEC.url}/api/submissions?limit=100`, { headers: hdr })).json();
  // DELETE on a submission ARCHIVES it — archived rows keep status "completed"
  // and still come back from the list endpoint, so without this filter deleted
  // test data gets re-filed into the employee records on the next sweep.
  const done = (list.data || [])
    .filter(s => !s.archived_at)
    .filter(s => s.completed_at || s.status === 'completed');
  const results = [];
  for (const s of done) {
    try { results.push(...await fileSubmission(s.id)); }
    catch (e) { results.push({ error: `submission ${s.id}: ${e.message}` }); }
  }
  return { completed: done.length, results };
}

const arg = process.argv[2];
if (arg === 'sweep') {
  const r = await sweep();
  console.log(`completed submissions: ${r.completed}`);
  for (const x of r.results) {
    console.log(x.error ? `  ERROR ${x.error}`
      : `  ${x.skipped ? 'already filed' : 'FILED'} [${x.bucket}] ${x.person} - ${x.file}`);
  }
} else if (arg) {
  for (const r of await fileSubmission(Number(arg))) {
    console.log(`${r.skipped ? 'already filed' : 'filed'} [${r.bucket}] ${r.person}\n   ${r.file}\n   ${r.link || ''}`);
  }
}
