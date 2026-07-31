import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_MANIFEST_SCHEMA_VERSION, orderedSources, sourceSlugs } from './registry.mjs';
import { validateSourceAttachmentSet } from './packet-topology.mjs';
import { validatePdfFingerprint } from './pdf-fingerprint.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function manifestDigest(value) {
  const provenance = {
    schemaVersion: value.schemaVersion,
    slug: value.slug,
    title: value.title,
    templateVersion: value.templateVersion,
    composite: value.composite,
    sources: value.sources.map(({
      outputStartPage,
      pageCount,
      attachmentFilename,
      attachmentSha256,
      attachmentFingerprint,
      ...source
    }) => source.kind === 'pdf' ? { ...source, pageCount } : source),
  };
  return sha256(Buffer.from(JSON.stringify(canonical(provenance)), 'utf8'));
}

export function measuredLayoutDigest(value) {
  const layout = {
    slug: value.slug,
    manifestSha256: value.manifestSha256,
    pdfSha256: value.pdfSha256,
    pageCount: value.pageCount,
    sources: value.sources.map((source) => ({
      slug: source.slug,
      outputStartPage: source.outputStartPage,
      pageCount: source.pageCount,
      sha256: source.sha256,
      attachmentFilename: source.attachmentFilename,
      attachmentSha256: source.attachmentSha256,
      attachmentFingerprint: source.attachmentFingerprint && {
        algorithm: source.attachmentFingerprint.algorithm,
        scale: source.attachmentFingerprint.scale,
        pageCount: source.attachmentFingerprint.pageCount,
        semanticSha256: source.attachmentFingerprint.semanticSha256,
        visualSha256: source.attachmentFingerprint.visualSha256,
        operatorSha256: source.attachmentFingerprint.operatorSha256,
      },
    })),
    fields: value.fields.map((field) => ({
      id: field.id, sourceSlug: field.sourceSlug, owner: field.owner, type: field.type,
      page: field.page, sourcePage: field.sourcePage, attachmentOrder: field.attachmentOrder,
      x: field.x, y: field.y, w: field.w, h: field.h,
    })),
  };
  return sha256(Buffer.from(JSON.stringify(canonical(layout)), 'utf8'));
}

export function sourceManifest(entry, docsDir, statutoryArtifacts = new Map()) {
  const sources = orderedSources(entry).map((source, order) => {
    if (source.kind === 'markdown') {
      const filename = `${source.slug}.md`;
      const bytes = readFileSync(resolve(docsDir, filename));
      return { order, kind: 'markdown', slug: source.slug, filename, sha256: sha256(bytes) };
    }
    if (source.kind === 'pdf') {
      const artifact = statutoryArtifacts.get(source.slug);
      if (!artifact) throw new Error(`${entry.slug}: statutory source ${source.slug} was not fetched`);
      return {
        order,
        kind: 'pdf',
        slug: source.slug,
        filename: `statutory/${source.slug}.pdf`,
        title: source.title,
        language: source.language,
        url: source.url,
        pageCount: artifact.pageCount,
        sha256: artifact.sha256,
      };
    }
    throw new Error(`${entry.slug}: unsupported source kind ${source.kind}`);
  });
  const manifest = {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    slug: entry.slug,
    title: entry.title,
    templateVersion: entry.version || 1,
    composite: sources.length > 1,
    sources,
  };
  return { ...manifest, manifestSha256: manifestDigest(manifest) };
}

export function validateManifestEntry(value, entry) {
  if (!value || value.schemaVersion !== BUILD_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`${entry.slug}: build manifest schema must be ${BUILD_MANIFEST_SCHEMA_VERSION}`);
  }
  if (value.slug !== entry.slug || value.title !== entry.title) {
    throw new Error(`${entry.slug}: build manifest identity does not match registry`);
  }
  if (value.templateVersion !== (entry.version || 1)) {
    throw new Error(`${entry.slug}: template version does not match registry`);
  }
  const expected = orderedSources(entry);
  if (!Array.isArray(value.sources) || value.sources.length !== expected.length) {
    throw new Error(`${entry.slug}: source count does not match ordered registry sources`);
  }
  value.sources.forEach((source, index) => {
    const definition = expected[index];
    const expectedFilename = definition.kind === 'pdf'
      ? `statutory/${definition.slug}.pdf`
      : `${definition.slug}.md`;
    if (source.order !== index || source.kind !== definition.kind ||
      source.slug !== definition.slug || source.filename !== expectedFilename) {
      throw new Error(`${entry.slug}: source ${index} does not match ordered registry source ${definition.slug}`);
    }
    if (definition.kind === 'pdf') {
      if (source.url !== definition.url || source.title !== definition.title ||
        source.language !== definition.language || !Number.isInteger(source.pageCount) || source.pageCount <= 0) {
        throw new Error(`${entry.slug}: statutory source ${definition.slug} metadata is invalid`);
      }
    }
    if (!SHA256.test(source.sha256 || '')) throw new Error(`${entry.slug}: source ${index} sha256 is invalid`);
  });
  if (value.composite !== (expected.length > 1)) throw new Error(`${entry.slug}: composite flag is invalid`);
  if (!SHA256.test(value.manifestSha256 || '') || value.manifestSha256 !== manifestDigest(value)) {
    throw new Error(`${entry.slug}: manifest digest is invalid`);
  }
  if (value.pdfSha256 !== undefined && !SHA256.test(value.pdfSha256)) {
    throw new Error(`${entry.slug}: PDF digest is invalid`);
  }
  return value;
}

export function assertCurrentSources(value, entry, docsDir, buildDir) {
  validateManifestEntry(value, entry);
  for (const source of value.sources) {
    const path = source.kind === 'pdf'
      ? resolve(buildDir, source.filename)
      : resolve(docsDir, source.filename);
    let bytes;
    try { bytes = readFileSync(path); }
    catch (error) { throw new Error(`${entry.slug}: cannot read source ${source.filename}: ${error.message}`); }
    if (sha256(bytes) !== source.sha256) {
      throw new Error(`${entry.slug}: canonical source changed after build; rebuild before template creation`);
    }
  }
  return value;
}

export function validateMeasuredBuild(document, entry, docsDir, buildDir, pdfBytes) {
  assertCurrentSources(document, entry, docsDir, buildDir);
  if (document.fields.length !== entry.fields) {
    throw new Error(`${document.slug}: build has ${document.fields.length} fields, expected ${entry.fields}`);
  }
  if (document.pdfSha256 !== sha256(pdfBytes)) {
    throw new Error(`${document.slug}: measured PDF digest does not match the file being uploaded`);
  }
  const ownerCounts = document.fields.reduce((counts, field) => {
    counts[field.owner] = (counts[field.owner] || 0) + 1;
    return counts;
  }, {});
  const registeredOwners = new Set();
  for (const [registeredOwner, expected] of Object.entries(entry.owners)) {
    const owner = registeredOwner === 'hamilton' ? 'employer' : registeredOwner;
    registeredOwners.add(owner);
    if ((ownerCounts[owner] || 0) !== expected) {
      throw new Error(`${document.slug}: ${owner} owns ${ownerCounts[owner] || 0} fields, expected ${expected}`);
    }
  }
  if (Object.keys(ownerCounts).some((owner) => !registeredOwners.has(owner))) {
    throw new Error(`${document.slug}: build contains an unregistered field owner`);
  }
  const expectedSources = new Set(sourceSlugs(entry));
  if (document.fields.some((field) => !expectedSources.has(field.sourceSlug))) {
    throw new Error(`${document.slug}: measured field has invalid source ownership`);
  }
  if (new Set(document.fields.map((field) => field.id)).size !== document.fields.length) {
    throw new Error(`${document.slug}: measured field anchor ids are not unique`);
  }
  const ordered = orderedSources(entry);
  const ranges = ordered.map((definition) => {
    const source = document.sources.find((candidate) => candidate.slug === definition.slug);
    if (!source || !Number.isInteger(source.outputStartPage) || source.outputStartPage < 0 ||
      !Number.isInteger(source.pageCount) || source.pageCount <= 0) {
      throw new Error(`${document.slug}: source ${definition.slug} has no complete output page range`);
    }
    return { slug: definition.slug, kind: definition.kind, start: source.outputStartPage, end: source.outputStartPage + source.pageCount };
  });
  ranges.forEach((range, index) => {
    const expectedStart = index === 0 ? 0 : ranges[index - 1].end;
    if (range.start !== expectedStart) {
      throw new Error(`${document.slug}: source ${range.slug} page range is not contiguous in registry order`);
    }
  });
  if (ranges.at(-1)?.end !== document.pageCount) {
    throw new Error(`${document.slug}: source page ranges do not cover the complete PDF`);
  }
  for (const field of document.fields) {
    const range = ranges.find((candidate) => candidate.slug === field.sourceSlug);
    if (!range || range.kind !== 'markdown' || field.page < range.start || field.page >= range.end) {
      throw new Error(`${document.slug}: field ${field.id} falls outside its source page range`);
    }
  }
  if (entry.pageCount !== undefined && document.pageCount !== entry.pageCount) {
    throw new Error(`${document.slug}: build has ${document.pageCount} pages, expected ${entry.pageCount}`);
  }
  if (entry.orderedSourceAttachments) {
    for (const source of document.sources) {
      validatePdfFingerprint(source.attachmentFingerprint, `${document.slug}: ${source.slug} attachment fingerprint`);
      if (source.attachmentFingerprint.pageCount !== source.pageCount) {
        throw new Error(`${document.slug}: ${source.slug} fingerprint page count differs from source range`);
      }
    }
    validateSourceAttachmentSet(document, buildDir, entry.providerDocuments);
  }
  if (!SHA256.test(document.layoutSha256 || '') || document.layoutSha256 !== measuredLayoutDigest(document)) {
    throw new Error(`${document.slug}: measured layout digest is invalid`);
  }
  return document;
}
