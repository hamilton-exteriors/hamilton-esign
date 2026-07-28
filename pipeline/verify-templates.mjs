// Check every live template's rendered page, not the DOM it was built from.
//
// This exists because a Letter @page rule shipped documents whose content was
// scaled into the top-left ~43% of each sheet while the field coordinates were
// measured against the unscaled DOM. Every field landed high and left of its
// rule, on live templates, and nothing in the pipeline noticed: build-docs,
// measure and build-templates were each internally consistent and all three
// agreed with each other. Only the PDF disagreed, and nothing read the PDF.
//
// Measuring the ink box of DocuSeal's own rasterised page is the one check that
// would have caught it, because DocuSeal's raster is what the signer sees.
//
//   node pipeline/verify-templates.mjs
import { readFileSync } from 'node:fs';
import pw from 'file:///C:/Users/admin/AppData/Roaming/npm/node_modules/playwright/index.js';
const { chromium } = pw;

const SEC = JSON.parse(readFileSync('C:/Users/admin/.claude/.hamilton-secrets/docuseal.json', 'utf8'));
const api = (p) => fetch(`${SEC.url}${p}`, { headers: { 'X-Auth-Token': SEC.apiKey } }).then((r) => r.json());

// Derived from the page geometry, never hardcoded. A fixed floor was written
// against the old 420px page (content 86% of width) and then failed all 14
// templates the day the page became Letter, where content is correctly 5.75in
// of 8.5in = 68%. A check whose threshold assumes one layout stops being a check
// the moment the layout changes.
//
// The real failure it exists to catch is content scaled into a corner, which
// halves the span, so a relative band around the expected value separates the
// two cleanly.
import { PAGE } from './build-docs.mjs';
const EXPECTED_SPAN = (PAGE.w - PAGE.ml - PAGE.mr) / PAGE.w;
const MIN_WIDTH_SPAN = EXPECTED_SPAN * 0.8;
const MAX_WIDTH_SPAN = EXPECTED_SPAN * 1.15;

const inkBox = async (page, src) => page.evaluate(async (url) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('image load failed')); img.src = url; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let minX = c.width, maxX = 0, minY = c.height, maxY = 0, ink = 0;
  for (let y = 0; y < c.height; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4;
      if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) {
        ink++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { w: c.width, h: c.height, minX, maxX, minY, maxY, ink };
}, src);

const list = await api('/api/templates?limit=60');
const templates = (list.data || []).filter((t) => !t.archived_at);
const browser = await chromium.launch();
const page = await browser.newPage();
let bad = 0;

for (const t of templates.sort((a, b) => a.name.localeCompare(b.name))) {
  const full = await api(`/api/templates/${t.id}`);
  const src = full.documents?.[0]?.preview_image_url;
  if (!src) { console.log(`  ??    ${t.name} (no preview)`); continue; }
  let r;
  try { r = await inkBox(page, src); } catch (e) { console.log(`  ERR   ${t.name}: ${e.message}`); bad++; continue; }
  const span = (r.maxX - r.minX) / r.w;
  const ok = span >= MIN_WIDTH_SPAN && span <= MAX_WIDTH_SPAN && r.ink > 0;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${String(t.id).padStart(3)}  ${t.name.slice(0, 44).padEnd(45)} ink spans ${(span * 100).toFixed(0)}% of width`);
}
await browser.close();
console.log(bad
  ? `\n${bad} template(s) render scaled. Check that @page in build-docs matches PAGE, and that measure.mjs passes preferCSSPageSize.`
  : `\nall ${templates.length} templates fill their page`);
process.exit(bad ? 1 : 0);
