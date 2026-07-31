// Stamp live field UUIDs into checked-in reading views without rebuilding live
// templates. Identity is geometry/type/role, never API array order.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { BUILD_DIR } from './config.mjs';
import { createDocusealClient } from './docuseal-api.mjs';
import { STAMP_TEMPLATE_REGISTRY, requireUniqueActiveTemplate } from './registry.mjs';
import { matchGeneratedFields } from './field-match.mjs';
import { stampReflowAnchors } from './reflow-anchor.mjs';

const client = createDocusealClient();
const apply = process.argv.includes('--apply');
const fieldsPath = `${BUILD_DIR}/fields.json`;
if (!existsSync(fieldsPath)) {
  throw new Error(`missing ${fieldsPath}; run build-docs and measure with HAMILTON_BUILD_DIR set if needed`);
}
const documents = JSON.parse(readFileSync(fieldsPath, 'utf8'));
const bySlug = new Map(documents.map((document) => [document.slug, document]));
const inventory = await client.listAll('/api/templates', { what: 'template inventory' });

let written = 0;
const problems = [];
for (const entry of STAMP_TEMPLATE_REGISTRY) {
  try {
    const template = requireUniqueActiveTemplate(inventory, entry.title);
    const generated = bySlug.get(entry.slug);
    if (!generated) throw new Error('not present in fields.json');
    const full = await client.request(`/api/templates/${template.id}`, {}, `template ${template.id}`);
    const mapping = matchGeneratedFields(generated.fields, full);

    const path = new URL(`../brand/reflow/${entry.slug}.reflow.html`, import.meta.url);
    const generatedPath = `${BUILD_DIR}/${entry.slug}.reflow.html`;
    if (!existsSync(generatedPath)) throw new Error('generated reading view file is missing');
    const source = readFileSync(generatedPath, 'utf8');
    const stampedResult = stampReflowAnchors(source, generated.fields, mapping);
    const html = stampedResult.html;
    const stamped = stampedResult.stamped;
    const markers = (html.match(/class="ds[^"]*"/g) || []).length;
    const uuids = [...html.matchAll(/data-hx-uuid="([^"]+)"/g)].map((match) => match[1]);
    if (stamped !== markers || uuids.length !== new Set(uuids).size || stamped !== entry.fields) {
      throw new Error(`expected ${entry.fields} unique anchors, stamped ${stamped}/${markers}`);
    }
    console.log(`  ok  ${entry.slug.padEnd(34)} ${stamped}/${markers} anchors (template ${template.id})`);
    if (apply) {
      writeFileSync(path, html);
      written++;
    }
  } catch (error) {
    problems.push(`${entry.slug}: ${error.message}`);
    console.error(`  FAIL  ${entry.slug}: ${error.message}`);
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s); failed closed.`);
  process.exit(1);
}
if (!STAMP_TEMPLATE_REGISTRY.length) throw new Error('stamp template registry is empty');
console.log(apply ? `\nstamped ${written} reading views` : `\nverified ${STAMP_TEMPLATE_REGISTRY.length} reading views; re-run with --apply`);
