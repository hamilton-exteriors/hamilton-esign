// Verify the complete live template inventory against every page of DocuSeal's
// source PDF plus field ownership metadata. Zero or partial work is failure.
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { createDocusealClient } from './docuseal-api.mjs';
import { CURRENT_TEMPLATE_REGISTRY, TEMPLATE_REGISTRY, requireUniqueActiveTemplate } from './registry.mjs';
import { PAGE } from './build-docs.mjs';

globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const client = createDocusealClient();
const expectedSpan = (PAGE.w - PAGE.ml - PAGE.mr) / PAGE.w;
const minWidthSpan = expectedSpan * 0.8;
const maxWidthSpan = expectedSpan * 1.15;

function inkBox(context, width, height) {
  const data = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let maxX = 0;
  let ink = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4;
      if (data[index] < 200 || data[index + 1] < 200 || data[index + 2] < 200) {
        ink++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { width, minX, maxX, ink };
}

async function inspectPdf(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`source PDF returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('source PDF is empty');
  const loadingTask = getDocument({ data: bytes, disableWorker: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const pdfPage = await pdf.getPage(pageNumber);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      pages.push(inkBox(context, width, height));
      pdfPage.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

const inventory = await client.listAll('/api/templates', { what: 'template inventory' });
const active = inventory.filter((template) => !template.archived_at);
if (!active.length) throw new Error('template verification returned zero active templates');
const expectedTitles = new Set(TEMPLATE_REGISTRY.map((entry) => entry.title));
const unexpected = active.filter((template) => !expectedTitles.has(template.name));
if (unexpected.length) throw new Error(`unexpected active templates: ${unexpected.map((template) => template.name).join('; ')}`);

const failures = [];
for (const entry of CURRENT_TEMPLATE_REGISTRY) {
  try {
    const template = requireUniqueActiveTemplate(active, entry.title);
    const full = await client.request(`/api/templates/${template.id}`, {}, `template ${template.id}`);
    const fields = full.fields || [];
    if (fields.length !== entry.fields) throw new Error(`fields ${fields.length}, expected ${entry.fields}`);

    const rolesByUuid = new Map((full.submitters || []).map((submitter) => [submitter.uuid, submitter.name]));
    const ownerCounts = { worker: 0, hamilton: 0 };
    for (const field of fields) {
      const role = rolesByUuid.get(field.submitter_uuid);
      if (/worker/i.test(role || '')) ownerCounts.worker++;
      else if (/hamilton/i.test(role || '')) ownerCounts.hamilton++;
      else throw new Error(`field ${field.uuid} has unknown role ${role || 'none'}`);
    }
    for (const [owner, count] of Object.entries(entry.owners)) {
      if (ownerCounts[owner] !== count) throw new Error(`${owner} fields ${ownerCounts[owner]}, expected ${count}`);
    }
    if ((full.submitters || []).length > 1 && full.preferences?.submitters_order !== 'preserved') {
      throw new Error('submitter order is not preserved');
    }

    const sourceUrl = full.documents?.[0]?.url;
    if (!sourceUrl) throw new Error('no source PDF URL');
    const pages = await inspectPdf(sourceUrl);
    const minimumPages = Math.max(1,
      ...fields.flatMap((field) => field.areas || []).map((area) => Number(area.page) + 1));
    if (pages.length < minimumPages) {
      throw new Error(`PDF has ${pages.length} pages, fields require at least ${minimumPages}`);
    }
    for (let index = 0; index < pages.length; index++) {
      const result = pages[index];
      if (!result.ink) throw new Error(`page ${index + 1} has no ink`);
      if (index === 0) {
        const span = (result.maxX - result.minX) / result.width;
        if (span < minWidthSpan || span > maxWidthSpan) {
          throw new Error(`first-page ink spans ${(span * 100).toFixed(0)}% of width`);
        }
      }
    }
    console.log(`  ok  ${String(template.id).padStart(3)}  ${entry.title.padEnd(48)} ${pages.length}p ${fields.length}f`);
  } catch (error) {
    failures.push(`${entry.title}: ${error.message}`);
    console.error(`  FAIL  ${entry.title}: ${error.message}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} template verification failure(s)`);
  process.exit(1);
}
console.log(`\nverified all ${CURRENT_TEMPLATE_REGISTRY.length} current templates`);
