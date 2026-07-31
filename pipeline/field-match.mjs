const ownerName = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'employer' || normalized === 'hamilton') return 'hamilton';
  if (normalized === 'worker' || normalized === 'employee' || normalized === 'contractor') return 'worker';
  return normalized;
};

const numberKey = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid field coordinate ${value}`);
  return number.toFixed(5);
};

function geometryKey(sourceSlug, page, x, y, w, h, type, owner) {
  if (!sourceSlug) throw new Error('field source attachment identity is missing');
  return [
    sourceSlug,
    Number(page),
    numberKey(x),
    numberKey(y),
    numberKey(w),
    numberKey(h),
    type,
    ownerName(owner),
  ].join('|');
}

export function generatedFieldKey(field) {
  return geometryKey(
    field.sourceSlug,
    field.sourcePage ?? field.page,
    field.x, field.y, field.w, field.h,
    field.type,
    field.owner,
  );
}

export function liveFieldKey(field, submitters, sourceSlugByAttachmentUuid) {
  const area = field.areas?.[0];
  if (!area || field.areas.length !== 1) {
    throw new Error(`live field ${field.uuid || field.name} must have exactly one area`);
  }
  const submitter = submitters.find((entry) => entry.uuid === field.submitter_uuid);
  if (!submitter) throw new Error(`live field ${field.uuid || field.name} has an unknown submitter`);
  const sourceSlug = sourceSlugByAttachmentUuid.get(area.attachment_uuid);
  return geometryKey(
    sourceSlug,
    area.page,
    area.x, area.y, area.w, area.h,
    field.type,
    submitter.name,
  );
}

function sourceAttachmentMap(sources, schema) {
  if (!Array.isArray(sources) || !sources.length || !Array.isArray(schema) || schema.length !== sources.length) {
    throw new Error('source manifest and live attachment schema must have equal nonzero length');
  }
  const map = new Map();
  schema.forEach((document, index) => {
    const uuid = document?.attachment_uuid;
    const slug = sources[index]?.slug;
    if (!uuid || !slug || map.has(uuid)) throw new Error('live attachment order/identity is invalid');
    map.set(uuid, slug);
  });
  return map;
}

export function matchGeneratedFields(generatedFields, liveTemplate, sources) {
  const liveFields = liveTemplate.fields || [];
  const submitters = liveTemplate.submitters || [];
  if (generatedFields.length !== liveFields.length) {
    throw new Error(`field count mismatch: generated ${generatedFields.length}, live ${liveFields.length}`);
  }
  const sourceSlugByAttachmentUuid = sourceAttachmentMap(sources, liveTemplate.schema);

  const liveByKey = new Map();
  for (const field of liveFields) {
    const key = liveFieldKey(field, submitters, sourceSlugByAttachmentUuid);
    if (liveByKey.has(key)) throw new Error(`ambiguous live fields share ${key}`);
    if (!field.uuid) throw new Error(`live field ${field.name || key} has no uuid`);
    liveByKey.set(key, field);
  }

  const matched = new Map();
  const usedUuids = new Set();
  for (const field of generatedFields) {
    const key = generatedFieldKey(field);
    const live = liveByKey.get(key);
    if (!live) throw new Error(`no live field matches ${field.id} (${field.name}) at ${key}`);
    if (usedUuids.has(live.uuid)) throw new Error(`live uuid ${live.uuid} matched more than once`);
    usedUuids.add(live.uuid);
    matched.set(field.id, live.uuid);
  }
  if (matched.size !== liveFields.length) throw new Error('not every live field was matched');
  return matched;
}
