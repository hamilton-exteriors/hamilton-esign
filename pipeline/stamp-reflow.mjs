// Stamp the LIVE field uuids into the reading views, without recreating anything.
//
// build-templates stamps as it mints, which only helps documents built from now
// on. The 14 templates already in production were created before that existed,
// and rebuilding them to get uuids would invalidate every signing link already
// sent — which has happened three times today and should not happen a fourth.
//
// Order is the join key: build-templates creates template fields by mapping over
// fields.json in order, so live.fields[i] is d.fields[i]. The span id from
// build-docs ("f7") is what the reading view carries, so the map is
// d.fields[i].id -> live.fields[i].uuid.
//
//   node pipeline/stamp-reflow.mjs          report only
//   node pipeline/stamp-reflow.mjs --apply  write the stamps
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DIR = 'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/build';
const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));
const api = (p) => fetch(`${SEC.url}${p}`, { headers: { 'X-Auth-Token': SEC.apiKey } }).then((r) => r.json());
const APPLY = process.argv.includes('--apply');

const TITLES = JSON.parse(readFileSync(new URL('../brand/reflow/index.json', import.meta.url), 'utf8'));
const slugByName = TITLES;                                  // name -> slug
const docs = JSON.parse(readFileSync(`${DIR}/fields.json`, 'utf8'));
const bySlug = Object.fromEntries(docs.map((d) => [d.slug, d]));

const list = await api('/api/templates?limit=60');
const live = (list.data || []).filter((t) => !t.archived_at);

let done = 0;
let problems = 0;
for (const t of live) {
  const slug = slugByName[t.name];
  if (!slug) { console.log(`  ??  no reading view mapped for "${t.name}"`); continue; }
  const d = bySlug[slug];
  if (!d) { console.log(`  ??  ${slug}: not in fields.json, rebuild docs first`); problems++; continue; }

  const full = await api(`/api/templates/${t.id}`);
  const lf = full.fields || [];
  if (lf.length !== d.fields.length) {
    console.log(`  !!  ${slug}: live has ${lf.length} fields, build has ${d.fields.length}. ` +
      'The reading view and the template are out of sync; rebuild rather than guess.');
    problems++;
    continue;
  }

  const path = new URL(`../brand/reflow/${slug}.reflow.html`, import.meta.url);
  if (!existsSync(path)) { console.log(`  ??  ${slug}: no reading view file`); problems++; continue; }
  let html = readFileSync(path, 'utf8');
  // Idempotent: drop any previous stamps before writing the current ones.
  html = html.replace(/ data-hx-uuid="[^"]*"/g, '');

  let stamped = 0;
  for (let i = 0; i < d.fields.length; i++) {
    const before = html;
    html = html.replace(`id="${d.fields[i].id}"`, `id="${d.fields[i].id}" data-hx-uuid="${lf[i].uuid}"`);
    if (html !== before) stamped++;
  }
  const markers = (html.match(/class="ds[^"]*"/g) || []).length;
  const ok = stamped === markers;
  if (!ok) problems++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${slug.padEnd(34)} ${stamped}/${markers} anchors  (template ${t.id})`);
  if (ok && APPLY) { writeFileSync(path, html); done++; }
}

console.log(problems
  ? `\n${problems} problem(s); nothing written for those.`
  : APPLY ? `\nstamped ${done} reading view(s)` : '\nall clean; re-run with --apply');
process.exit(problems ? 1 : 0);
