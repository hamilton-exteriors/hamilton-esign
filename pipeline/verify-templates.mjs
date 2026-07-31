// Verify the complete live template inventory against every page of DocuSeal's
// source PDF plus field ownership metadata. Zero or partial work is failure.
import { existsSync, readFileSync } from 'node:fs';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { createDocusealClient } from './docuseal-api.mjs';
import { BUILD_DIR } from './config.mjs';
import { sha256 } from './build-manifest.mjs';
import { fingerprintPdf } from './pdf-fingerprint.mjs';
import {
  CURRENT_TEMPLATE_REGISTRY,
  RETAINED_LEGACY_TEMPLATE_REGISTRY,
  SOURCE_ONLY_TEMPLATE_REGISTRY,
  TEMPLATE_REGISTRY,
  requireUniqueActiveTemplate,
} from './registry.mjs';
import {
  PDFJS_NODE_ASSETS,
  entriesForScope,
  inspectInkBands,
  liveExpectation,
  parseVerifierArgs,
  stampedReflowUuidMap,
  validateActiveInventory,
  validateFirstPageBodyInk,
  validateLetterNormalizedPageSizes,
  validateProviderDocumentTopology,
} from './template-verifier.mjs';
import {
  requireProviderAttestationEntry,
  validateProviderAttestation,
} from './provider-attestation.mjs';

globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { scope } = parseVerifierArgs(process.argv.slice(2));
const registry = entriesForScope({
  current: CURRENT_TEMPLATE_REGISTRY,
  retainedLegacy: RETAINED_LEGACY_TEMPLATE_REGISTRY,
}, scope);
const measuredPath = `${BUILD_DIR}/fields.json`;
const measuredBySlug = existsSync(measuredPath)
  ? new Map(JSON.parse(readFileSync(measuredPath, 'utf8')).map((document) => [document.slug, document]))
  : new Map();
// Current ordered-source packets (v4) are pinned by the live attestation file;
// the retained v3 generation is pinned by the immutable retained copy of its
// gen-C attestation, kept so 380/381 stay verifiable after the v4 capture
// replaced provider-attestations.json.
const attestationPath = new URL('../brand/reflow/provider-attestations.json', import.meta.url);
const retainedAttestationPath = new URL('../brand/reflow/provider-attestations-v2.json', import.meta.url);
const providerAttestation = registry.some((entry) => entry.orderedSourceAttachments && !entry.legacy)
  ? validateProviderAttestation(JSON.parse(readFileSync(attestationPath, 'utf8')))
  : null;
const retainedProviderAttestation = registry.some((entry) => entry.orderedSourceAttachments && entry.legacy)
  ? validateProviderAttestation(JSON.parse(readFileSync(retainedAttestationPath, 'utf8')))
  : null;

const client = createDocusealClient();

async function inspectPdf(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`source PDF returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('source PDF is empty');
  // PDF.js may transfer/detach the supplied ArrayBuffer. Capture the provider's raw
  // bytes before handing ownership to the parser; hashing afterward can hash a detached
  // or parser-owned view instead of the response that was actually downloaded.
  const rawSha256 = sha256(bytes);
  const sourceByteLength = bytes.byteLength;
  const fingerprint = await fingerprintPdf(bytes);
  const loadingTask = getDocument({ data: bytes, disableWorker: true, ...PDFJS_NODE_ASSETS });
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
      pages.push({
        ...inspectInkBands(context, width, height),
        // Exact PDF-space page size at scale 1, before the raster ceil, so
        // letter-normalized packets can require exactly 612x792 per page.
        width: viewport.width,
        height: viewport.height,
      });
      pdfPage.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { sha256: rawSha256, sourceByteLength, fingerprint, pages };
}

const inventory = await client.listAll('/api/templates', { what: 'template inventory' });
const active = inventory.filter((template) => !template.archived_at);
if (!active.length) throw new Error('template verification returned zero active templates');
validateActiveInventory(
  active,
  TEMPLATE_REGISTRY.filter((entry) => !entry.sourceOnly),
  SOURCE_ONLY_TEMPLATE_REGISTRY,
);

const failures = [];
for (const entry of registry) {
  try {
    const template = requireUniqueActiveTemplate(active, entry.title);
    const full = await client.request(`/api/templates/${template.id}`, {}, `template ${template.id}`);
    const fields = full.fields || [];
    const expected = liveExpectation(entry);
    if (fields.length !== expected.fields) throw new Error(`fields ${fields.length}, expected ${expected.fields}`);

    const rolesByUuid = new Map((full.submitters || []).map((submitter) => [submitter.uuid, submitter.name]));
    const ownerCounts = { worker: 0, hamilton: 0 };
    for (const field of fields) {
      const role = rolesByUuid.get(field.submitter_uuid);
      if (/worker/i.test(role || '')) ownerCounts.worker++;
      else if (/hamilton/i.test(role || '')) ownerCounts.hamilton++;
      else throw new Error(`field ${field.uuid} has unknown role ${role || 'none'}`);
    }
    for (const [owner, count] of Object.entries(expected.owners)) {
      if (ownerCounts[owner] !== count) throw new Error(`${owner} fields ${ownerCounts[owner]}, expected ${count}`);
    }
    if ((full.submitters || []).length > 1 && full.preferences?.submitters_order !== 'preserved') {
      throw new Error('submitter order is not preserved');
    }

    if (!Array.isArray(full.documents) || !full.documents.length ||
      full.documents.some((document) => !document.url)) {
      throw new Error('provider source PDF URLs are incomplete');
    }
    const inspections = [];
    for (const document of full.documents) inspections.push(await inspectPdf(document.url));
    const measured = measuredBySlug.get(entry.slug);
    let uuidByFieldId;
    let attestationEntry;
    const attestationForEntry = entry.legacy ? retainedProviderAttestation : providerAttestation;
    if (entry.orderedSourceAttachments) {
      const reflowPath = new URL(`../brand/reflow/${entry.slug}.reflow.html`, import.meta.url);
      if (!existsSync(reflowPath)) throw new Error('post-create UUID-stamped reflow artifact is missing');
      const reflowBytes = readFileSync(reflowPath);
      uuidByFieldId = stampedReflowUuidMap(reflowBytes.toString('utf8'), measured?.fields || []);
      attestationEntry = requireProviderAttestationEntry(attestationForEntry, entry.slug);
      if (attestationEntry.reflowSha256 !== sha256(reflowBytes)) {
        throw new Error('UUID-stamped reflow bytes differ from committed provider attestation');
      }
    }
    const topology = validateProviderDocumentTopology({
      entry,
      template: full,
      measured,
      inspections,
      uuidByFieldId,
      attestation: attestationForEntry,
      attestationEntry,
    });
    if (entry.letterNormalized) validateLetterNormalizedPageSizes(inspections);
    const pages = inspections.flatMap((inspection) => inspection.pages);
    for (let index = 0; index < pages.length; index++) {
      const result = pages[index];
      if (!result.full.ink) throw new Error(`global page ${index + 1} has no ink`);
      if (index === 0) validateFirstPageBodyInk(result);
    }
    console.log(`  ok  ${String(template.id).padStart(3)}  ${entry.title.padEnd(48)} ${topology.totalPages}p ${full.documents.length}d ${fields.length}f`);
  } catch (error) {
    failures.push(`${entry.title}: ${error.message}`);
    console.error(`  FAIL  ${entry.title}: ${error.message}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} template verification failure(s)`);
  process.exit(1);
}
console.log(`\nverified ${registry.length} ${scope} templates`);
