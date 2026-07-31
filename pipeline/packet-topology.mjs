import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PDF_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/;
const SAFE_PROVIDER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function canonicalProviderPdfName(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
    /[\\/\p{Cc}\p{Cs}]/u.test(value)) {
    throw new Error('provider PDF name must be a trimmed path-free string');
  }
  const canonical = value.endsWith('.pdf') ? value.slice(0, -4) : value;
  if (!SAFE_PROVIDER_NAME.test(canonical)) {
    throw new Error('provider PDF name differs beyond an optional final .pdf suffix');
  }
  return canonical;
}

export const bytesSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function attachmentFilenameForSource(source) {
  if (!source?.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.slug)) {
    throw new Error('source slug cannot produce a safe attachment filename');
  }
  return `${source.slug}.pdf`;
}

export function mapFieldsToSourceAttachments(fields, sources) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('ordered packet sources are required');
  const bySlug = new Map();
  sources.forEach((source, order) => {
    if (source.order !== order || bySlug.has(source.slug)) {
      throw new Error('packet sources must have unique slugs in exact manifest order');
    }
    if (!Number.isInteger(source.outputStartPage) || source.outputStartPage < 0 ||
      !Number.isInteger(source.pageCount) || source.pageCount <= 0) {
      throw new Error(`${source.slug}: packet source has an invalid global page range`);
    }
    bySlug.set(source.slug, source);
  });
  return fields.map((field) => {
    const source = bySlug.get(field.sourceSlug);
    if (!source) throw new Error(`${field.id}: field source is absent from packet attachments`);
    const sourcePage = field.page - source.outputStartPage;
    if (!Number.isInteger(sourcePage) || sourcePage < 0 || sourcePage >= source.pageCount) {
      throw new Error(`${field.id}: global page ${field.page} falls outside ${source.slug}`);
    }
    return { ...field, sourcePage, attachmentOrder: source.order };
  });
}

export function validateSourceAttachmentSet(document, buildDir, expectedCount = 15) {
  if (!Array.isArray(document?.sources) || document.sources.length !== expectedCount) {
    throw new Error(`${document?.slug || 'packet'}: expected ${expectedCount} ordered source attachments`);
  }
  const names = new Set();
  let totalPages = 0;
  document.sources.forEach((source, order) => {
    const expectedFilename = attachmentFilenameForSource(source);
    if (source.order !== order || source.attachmentFilename !== expectedFilename ||
      !SAFE_PDF_FILENAME.test(source.attachmentFilename || '')) {
      throw new Error(`${document.slug}: source attachment ${order} filename/order is invalid`);
    }
    if (names.has(source.attachmentFilename)) {
      throw new Error(`${document.slug}: duplicate source attachment filename ${source.attachmentFilename}`);
    }
    names.add(source.attachmentFilename);
    if (!SHA256.test(source.attachmentSha256 || '')) {
      throw new Error(`${document.slug}: ${source.attachmentFilename} digest is invalid`);
    }
    const path = resolve(buildDir, `${document.slug}.sources`, source.attachmentFilename);
    const bytes = readFileSync(path);
    if (bytesSha256(bytes) !== source.attachmentSha256) {
      throw new Error(`${document.slug}: ${source.attachmentFilename} bytes differ from measured digest`);
    }
    totalPages += source.pageCount;
  });
  if (totalPages !== document.pageCount) {
    throw new Error(`${document.slug}: source attachments total ${totalPages} pages, expected ${document.pageCount}`);
  }
  const mapped = mapFieldsToSourceAttachments(document.fields, document.sources);
  mapped.forEach((field, index) => {
    if (document.fields[index].sourcePage !== field.sourcePage ||
      document.fields[index].attachmentOrder !== field.attachmentOrder) {
      throw new Error(`${document.slug}: field ${field.id} source-local mapping is stale`);
    }
  });
  return document;
}

export function orderedSourceUploads(document, buildDir, expectedCount = 15) {
  validateSourceAttachmentSet(document, buildDir, expectedCount);
  return document.sources.map((source) => ({
    slug: source.slug,
    filename: source.attachmentFilename,
    sha256: source.attachmentSha256,
    bytes: readFileSync(resolve(buildDir, `${document.slug}.sources`, source.attachmentFilename)),
  }));
}

export function appendOrderedSourceUploads(formData, uploads) {
  if (!formData || typeof formData.append !== 'function') throw new Error('multipart form data is required');
  if (!Array.isArray(uploads) || uploads.length !== 15) throw new Error('exactly 15 ordered source uploads are required');
  uploads.forEach((upload) => {
    formData.append('files[]', new Blob([upload.bytes], { type: 'application/pdf' }), upload.filename);
  });
  return uploads.length;
}

export function providerFieldGeometry(field, attachmentUuid) {
  if (!attachmentUuid) throw new Error(`${field?.id || 'field'}: attachment UUID is required`);
  if (!Number.isInteger(field?.sourcePage) || field.sourcePage < 0) {
    throw new Error(`${field?.id || 'field'}: source-local page is required`);
  }
  return {
    page: field.sourcePage,
    x: field.x,
    y: field.y,
    w: field.w,
    h: field.h,
    attachment_uuid: attachmentUuid,
  };
}
