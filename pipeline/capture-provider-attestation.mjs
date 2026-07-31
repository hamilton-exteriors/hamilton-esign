// Read-only provider capture. Downloads current v3 source bytes, proves exact byte identity
// with every approved local source, and writes a commit-ready attestation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createDocusealClient } from './docuseal-api.mjs';
import { BUILD_DIR } from './config.mjs';
import { sha256, validateMeasuredBuild } from './build-manifest.mjs';
import { DOCS_DIR } from './config.mjs';
import { CURRENT_TEMPLATE_REGISTRY, requireUniqueActiveTemplate } from './registry.mjs';
import { canonicalProviderPdfName } from './packet-topology.mjs';
import { fingerprintPdf, fingerprintsEqual } from './pdf-fingerprint.mjs';
import { buildProviderAttestation } from './provider-attestation.mjs';
import { expectedProviderFieldMetadata, stampedReflowUuidMap, verifyExactMeasuredFields } from './template-verifier.mjs';

if (process.argv.length !== 2) throw new Error('usage: node pipeline/capture-provider-attestation.mjs');
const entries = CURRENT_TEMPLATE_REGISTRY.filter((entry) => entry.version === 3 && entry.orderedSourceAttachments);
if (entries.length !== 2) throw new Error('provider attestation capture requires exactly two current W-2 v3 entries');
const measured = JSON.parse(readFileSync(`${BUILD_DIR}/fields.json`, 'utf8'));
const measuredBySlug = new Map(measured.map((document) => [document.slug, document]));
const client = createDocusealClient();
const inventory = await client.listAll('/api/templates', { what: 'read-only provider attestation inventory' });
const active = inventory.filter((template) => !template.archived_at);
const attestationEntries = [];
for (const entry of entries) {
  const summary = requireUniqueActiveTemplate(active, entry.title);
  const template = await client.request(`/api/templates/${summary.id}`, {}, `read-only template ${summary.id}`);
  const local = measuredBySlug.get(entry.slug);
  validateMeasuredBuild(local, entry, DOCS_DIR, BUILD_DIR, readFileSync(`${BUILD_DIR}/${entry.slug}.pdf`));
  const reflowPath = new URL(`../brand/reflow/${entry.slug}.reflow.html`, import.meta.url);
  if (!existsSync(reflowPath)) throw new Error(`${entry.slug}: UUID-stamped reflow artifact is missing`);
  const reflowBytes = readFileSync(reflowPath);
  const uuidByFieldId = stampedReflowUuidMap(reflowBytes.toString('utf8'), local.fields);
  if (template.schema?.length !== 15 || template.documents?.length !== 15) {
    throw new Error(`${entry.slug}: provider topology is not 15 ordered documents`);
  }
  verifyExactMeasuredFields(template, local, template.schema, uuidByFieldId);
  const metadataById = expectedProviderFieldMetadata(local.fields);
  const documents = [];
  for (let index = 0; index < 15; index += 1) {
    const schema = template.schema[index];
    const provider = template.documents[index];
    const source = local.sources[index];
    if (!schema?.attachment_uuid || provider?.uuid !== schema.attachment_uuid ||
      canonicalProviderPdfName(provider.filename) !== canonicalProviderPdfName(source.attachmentFilename)) {
      throw new Error(`${entry.slug}: provider source ${index} identity/order differs from measured build`);
    }
    const response = await fetch(provider.url);
    if (!response.ok) throw new Error(`${entry.slug}: provider source ${index} returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const providerRawSha256 = sha256(bytes);
    if (providerRawSha256 !== source.attachmentSha256) {
      throw new Error(`${entry.slug}: provider source ${index} raw bytes differ from the approved local source`);
    }
    const fingerprint = await fingerprintPdf(bytes);
    if (!fingerprintsEqual(source.attachmentFingerprint, fingerprint)) {
      throw new Error(`${entry.slug}: provider source ${index} diagnostic fingerprint differs from measured build`);
    }
    documents.push({
      uuid: provider.uuid,
      filename: provider.filename,
      sourceByteLength: bytes.byteLength,
      localRawSha256: source.attachmentSha256,
      providerRawSha256,
      fingerprint,
      fieldRegions: local.fields
        .filter((field) => field.attachmentOrder === index)
        .map((field, order) => {
          const metadata = metadataById.get(field.id);
          return {
            order,
            id: field.id,
            uuid: uuidByFieldId.get(field.id),
            name: metadata.name,
            description: metadata.description,
            type: field.type,
            owner: field.owner,
            required: metadata.required,
            readonly: metadata.readonly,
            page: field.sourcePage,
            x: field.x,
            y: field.y,
            w: field.w,
            h: field.h,
          };
        }),
    });
  }
  attestationEntries.push({
    slug: entry.slug,
    registryVersion: entry.version,
    templateId: template.id,
    templateName: template.name,
    layoutSha256: local.layoutSha256,
    reflowSha256: sha256(reflowBytes),
    documents,
  });
}
const attestation = buildProviderAttestation(attestationEntries);
const output = new URL('../brand/reflow/provider-attestations.json', import.meta.url);
writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`);
console.log(`captured ${attestation.entries.length} read-only provider attestations ${attestation.attestationSha256}`);
