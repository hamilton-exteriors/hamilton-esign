import { PAGE } from './build-docs.mjs';
import { canonicalProviderPdfName } from './packet-topology.mjs';
import { validateProviderAttestation } from './provider-attestation.mjs';
export { PDFJS_NODE_ASSETS } from './pdfjs-assets.mjs';

export const BODY_BAND = Object.freeze({
  topRatio: PAGE.mt / PAGE.h,
  bottomRatio: 1 - (PAGE.mb / PAGE.h),
});

export const EXPECTED_BODY_BOUNDS = Object.freeze({
  leftRatio: PAGE.ml / PAGE.w,
  rightRatio: 1 - (PAGE.mr / PAGE.w),
  toleranceRatio: 0.03,
});

export function inkBox(context, width, height, { top = 0, bottom = height } = {}) {
  const data = context.getImageData(0, 0, width, height).data;
  const startY = Math.max(0, Math.floor(top));
  const endY = Math.min(height, Math.ceil(bottom));
  let minX = width;
  let maxX = 0;
  let ink = 0;
  for (let y = startY; y < endY; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4;
      if (data[index] < 200 || data[index + 1] < 200 || data[index + 2] < 200) {
        ink += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { width, height, minX, maxX, ink };
}

export function inspectInkBands(context, width, height) {
  return {
    full: inkBox(context, width, height),
    body: inkBox(context, width, height, {
      top: height * BODY_BAND.topRatio,
      bottom: height * BODY_BAND.bottomRatio,
    }),
  };
}

export function validateFirstPageBodyInk(result) {
  if (!result?.body?.ink) throw new Error('first page has no body ink');
  const minRatio = result.body.minX / result.body.width;
  const maxRatio = result.body.maxX / result.body.width;
  const expectedLeft = EXPECTED_BODY_BOUNDS.leftRatio;
  const expectedRight = EXPECTED_BODY_BOUNDS.rightRatio;
  const tolerance = EXPECTED_BODY_BOUNDS.toleranceRatio;
  if (Math.abs(minRatio - expectedLeft) > tolerance || Math.abs(maxRatio - expectedRight) > tolerance) {
    throw new Error(
      `first-page body ink bounds ${(minRatio * 100).toFixed(0)}%-${(maxRatio * 100).toFixed(0)}% do not match expected ` +
      `${(expectedLeft * 100).toFixed(0)}%-${(expectedRight * 100).toFixed(0)}%`,
    );
  }
  return { minRatio, maxRatio };
}

export function parseVerifierArgs(argv) {
  let scope = 'current';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--scope') {
      const next = argv[index + 1];
      if (!next) throw new Error('--scope requires current, w2-release, w2-cutover, or all-live');
      scope = next;
      index += 1;
    } else if (value.startsWith('--scope=')) {
      scope = value.slice('--scope='.length);
    } else {
      throw new Error('usage: node pipeline/verify-templates.mjs [--scope current|w2-release|w2-cutover|all-live]');
    }
  }
  if (!['current', 'w2-release', 'w2-cutover', 'all-live'].includes(scope)) {
    throw new Error('--scope must be current, w2-release, w2-cutover, or all-live');
  }
  return { scope };
}

const W2_RELEASE_SLUGS = new Set([
  'w2-initial-packet-v3',
  'w2-initial-packet-es-v3',
  'safety-training-roster',
  'safety-training-roster-es',
]);

const W2_CUTOVER_SLUGS = new Set([
  ...W2_RELEASE_SLUGS,
  'w2-initial-packet-v2',
  'w2-initial-packet-es-v2',
]);

export function stampedReflowUuidMap(html, measuredFields) {
  if (typeof html !== 'string') throw new Error('stamped reflow artifact is required');
  const expectedIds = new Set(measuredFields.map((field) => field.id));
  const mapping = new Map();
  for (const match of html.matchAll(/<span\b[^>]*>/g)) {
    const tag = match[0];
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    if (!expectedIds.has(id)) continue;
    const uuid = (tag.match(/\bdata-hx-uuid="([^"]+)"/) || [])[1];
    if (!uuid || mapping.has(id) || [...mapping.values()].includes(uuid)) {
      throw new Error('stamped reflow field IDs and UUIDs must be present and unique');
    }
    mapping.set(id, uuid);
  }
  if (mapping.size !== expectedIds.size) {
    throw new Error(`stamped reflow covers ${mapping.size} fields, expected ${expectedIds.size}`);
  }
  return mapping;
}

const CONDITIONAL_SECTION = /supervisor|capataz|foreman|driving|manejo de veh/i;
const CONDITIONAL_FIELD = /if assigned|si se asigna|if driving|si maneja|respirator|respirador|Section H|secci[óo]n H/i;
const PROVIDER_FIELD_NAME_MAX = 46;

export function expectedProviderFieldMetadata(fields) {
  const perOwner = {};
  for (const field of fields) perOwner[field.owner] = (perOwner[field.owner] || 0) + 1;
  const indexes = {};
  const seen = new Map();
  return new Map(fields.map((field) => {
    indexes[field.owner] = (indexes[field.owner] || 0) + 1;
    const total = perOwner[field.owner];
    const position = total >= 8 ? `${indexes[field.owner]}/${total} ` : '';
    let short = field.name;
    if (short.length > PROVIDER_FIELD_NAME_MAX) {
      const cut = short.slice(0, PROVIDER_FIELD_NAME_MAX);
      const space = cut.lastIndexOf(' ');
      short = (space > PROVIDER_FIELD_NAME_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s(,;:-]+$/, '') + '…';
    }
    let name = `${position}${short}`;
    const duplicate = (seen.get(name) || 0) + 1;
    seen.set(name, duplicate);
    if (duplicate > 1) name = `${name} (${duplicate})`;
    const conditional = field.type === 'checkbox' || CONDITIONAL_SECTION.test(field.section || '') || CONDITIONAL_FIELD.test(field.name || '');
    return [field.id, {
      name,
      description: field.section || '',
      required: !conditional,
      readonly: false,
    }];
  }));
}

const FIELD_GEOMETRY_KEYS = ['page', 'x', 'y', 'w', 'h'];

function verifierOwner(value) {
  if (/hamilton/i.test(value || '')) return 'employer';
  if (/worker/i.test(value || '')) return 'worker';
  return '';
}

export function verifyExactMeasuredFields(template, measured, schema, uuidByFieldId) {
  if (!(uuidByFieldId instanceof Map) || uuidByFieldId.size !== measured.fields.length) {
    throw new Error('exact stamped reflow UUID mapping is required for v3 field verification');
  }
  const liveByUuid = new Map((template.fields || []).map((field) => [field.uuid, field]));
  if (liveByUuid.size !== measured.fields.length || liveByUuid.size !== (template.fields || []).length) {
    throw new Error('provider field UUID coverage differs from measured packet');
  }
  const roles = new Map((template.submitters || []).map((submitter) => [submitter.uuid, submitter.name]));
  const metadataById = expectedProviderFieldMetadata(measured.fields);
  for (const expected of measured.fields) {
    const uuid = uuidByFieldId.get(expected.id);
    const actual = liveByUuid.get(uuid);
    const source = measured.sources[expected.attachmentOrder];
    const expectedAttachmentUuid = schema[expected.attachmentOrder]?.attachment_uuid;
    if (!actual || source?.slug !== expected.sourceSlug || !expectedAttachmentUuid) {
      throw new Error(`${expected.id}: provider field identity/source mapping is incomplete`);
    }
    const metadata = metadataById.get(expected.id);
    if (actual.type !== expected.type || verifierOwner(roles.get(actual.submitter_uuid)) !== expected.owner ||
      actual.name !== metadata.name || (actual.description || '') !== metadata.description ||
      Boolean(actual.required) !== metadata.required || Boolean(actual.readonly) !== metadata.readonly || actual.areas?.length !== 1) {
      throw new Error(`${expected.id}: provider field name/description/type/owner/required/readonly/area differs from measured packet`);
    }
    const area = actual.areas[0];
    const expectedGeometry = {
      page: expected.sourcePage,
      x: expected.x,
      y: expected.y,
      w: expected.w,
      h: expected.h,
    };
    if (area.attachment_uuid !== expectedAttachmentUuid ||
      FIELD_GEOMETRY_KEYS.some((key) => area[key] !== expectedGeometry[key])) {
      throw new Error(`${expected.id}: provider field attachment/local page/geometry differs from measured packet`);
    }
  }
}

export function validateProviderDocumentTopology({
  entry, template, measured, inspections, uuidByFieldId, attestation, attestationEntry,
}) {
  const schema = template?.schema || [];
  const documents = template?.documents || [];
  const expectedCount = entry.providerDocuments ?? 1;
  if (schema.length !== expectedCount || documents.length !== expectedCount || inspections.length !== expectedCount) {
    throw new Error(`provider documents ${documents.length}, schema ${schema.length}, inspected ${inspections.length}; expected ${expectedCount}`);
  }
  const seen = new Set();
  documents.forEach((document, index) => {
    const attachmentUuid = schema[index]?.attachment_uuid;
    if (!attachmentUuid || seen.has(attachmentUuid) || document?.uuid !== attachmentUuid) {
      throw new Error(`provider document ${index} UUID/order differs from schema`);
    }
    seen.add(attachmentUuid);
    if (canonicalProviderPdfName(schema[index]?.name) !== canonicalProviderPdfName(document.filename)) {
      throw new Error(`provider document ${index} filename/order differs from schema`);
    }
  });
  if (entry.orderedSourceAttachments) {
    validateProviderAttestation(attestation);
    if (!attestationEntry || attestationEntry.slug !== entry.slug ||
      attestationEntry.templateId !== String(template.id) || attestationEntry.templateName !== template.name ||
      attestationEntry.registryVersion !== entry.version || attestationEntry.layoutSha256 !== measured?.layoutSha256 ||
      attestationEntry.documents?.length !== expectedCount) {
      throw new Error('provider attestation does not bind this exact template/build');
    }
    if (!measured || measured.slug !== entry.slug || measured.sources?.length !== expectedCount) {
      throw new Error('local measured source-attachment manifest is required for v3 verification');
    }
    measured.sources.forEach((source, index) => {
      if (canonicalProviderPdfName(documents[index].filename) !== canonicalProviderPdfName(source.attachmentFilename)) {
        throw new Error(`provider source ${index} filename differs from measured manifest`);
      }
      const pinned = attestationEntry.documents[index];
      if (pinned.order !== index || pinned.uuid !== documents[index].uuid ||
        canonicalProviderPdfName(pinned.filename) !== canonicalProviderPdfName(documents[index].filename) ||
        pinned.localRawSha256 !== source.attachmentSha256 ||
        pinned.providerRawSha256 !== source.attachmentSha256 ||
        inspections[index].sha256 !== source.attachmentSha256 ||
        inspections[index].sourceByteLength !== pinned.sourceByteLength) {
        throw new Error(`provider source ${index} raw bytes/identity differ from the approved local source`);
      }
      const expectedFingerprint = source.attachmentFingerprint;
      const providerFingerprint = inspections[index].fingerprint;
      if (!expectedFingerprint || !providerFingerprint ||
        providerFingerprint.algorithm !== expectedFingerprint.algorithm ||
        providerFingerprint.scale !== expectedFingerprint.scale ||
        providerFingerprint.pageCount !== expectedFingerprint.pageCount ||
        providerFingerprint.semanticSha256 !== expectedFingerprint.semanticSha256 ||
        providerFingerprint.visualSha256 !== expectedFingerprint.visualSha256 ||
        providerFingerprint.operatorSha256 !== expectedFingerprint.operatorSha256 ||
        pinned.fingerprint.algorithm !== providerFingerprint.algorithm ||
        pinned.fingerprint.scale !== providerFingerprint.scale ||
        pinned.fingerprint.pageCount !== providerFingerprint.pageCount ||
        pinned.fingerprint.semanticSha256 !== providerFingerprint.semanticSha256 ||
        pinned.fingerprint.visualSha256 !== providerFingerprint.visualSha256 ||
        pinned.fingerprint.operatorSha256 !== providerFingerprint.operatorSha256) {
        throw new Error(`provider source ${index} diagnostic fingerprint differs from measured manifest`);
      }
      if (inspections[index].pages.length !== source.pageCount) {
        throw new Error(`provider source ${index} has ${inspections[index].pages.length} pages, expected ${source.pageCount}`);
      }
    });
    verifyExactMeasuredFields(template, measured, schema, uuidByFieldId);
    const metadataById = expectedProviderFieldMetadata(measured.fields);
    measured.sources.forEach((_, index) => {
      const expectedRegions = measured.fields
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
        });
      if (JSON.stringify(attestationEntry.documents[index].fieldRegions) !== JSON.stringify(expectedRegions)) {
        throw new Error(`provider source ${index} attested field regions differ from measured/live fields`);
      }
    });
  }
  const pagesByAttachment = new Map(schema.map((document, index) => [
    document.attachment_uuid,
    inspections[index].pages.length,
  ]));
  for (const field of template.fields || []) {
    if (field.areas?.length !== 1) throw new Error(`field ${field.uuid} must have exactly one area`);
    const area = field.areas[0];
    const pages = pagesByAttachment.get(area.attachment_uuid);
    if (!pages || !Number.isInteger(area.page) || area.page < 0 || area.page >= pages) {
      throw new Error(`field ${field.uuid} has invalid attachment/local page`);
    }
  }
  const totalPages = inspections.reduce((total, inspection) => total + inspection.pages.length, 0);
  if (entry.pageCount !== undefined && totalPages !== entry.pageCount) {
    throw new Error(`provider source documents total ${totalPages} pages, expected ${entry.pageCount}`);
  }
  return { totalPages, attachmentUuids: [...seen] };
}

export function validateActiveInventory(active, allowedEntries, sourceOnlyEntries) {
  const sourceOnlyTitles = new Set(sourceOnlyEntries.map((entry) => entry.title));
  const activeSourceOnly = active.filter((template) => sourceOnlyTitles.has(template.name));
  if (activeSourceOnly.length) {
    throw new Error(`source-only templates must not be active: ${activeSourceOnly.map((template) => template.name).join('; ')}`);
  }
  const expectedTitles = new Set(allowedEntries.map((entry) => entry.title));
  const unexpected = active.filter((template) => !expectedTitles.has(template.name));
  if (unexpected.length) {
    throw new Error(`unexpected active templates: ${unexpected.map((template) => template.name).join('; ')}`);
  }
}

export function liveExpectation(entry) {
  return {
    fields: entry.liveFields ?? entry.fields,
    owners: entry.liveOwners ?? entry.owners,
  };
}

export function entriesForScope({ current, retainedLegacy }, scope) {
  if (scope === 'w2-release') return current.filter((entry) => W2_RELEASE_SLUGS.has(entry.slug));
  if (scope === 'w2-cutover') return [...current, ...retainedLegacy].filter((entry) => W2_CUTOVER_SLUGS.has(entry.slug));
  if (scope === 'all-live') return [...current, ...retainedLegacy];
  return current;
}
