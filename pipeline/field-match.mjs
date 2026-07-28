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

export function generatedFieldKey(field) {
  return [
    Number(field.page),
    numberKey(field.x),
    numberKey(field.y),
    numberKey(field.w),
    numberKey(field.h),
    field.type,
    ownerName(field.owner),
  ].join('|');
}

export function liveFieldKey(field, submitters) {
  const area = field.areas?.[0];
  if (!area || field.areas.length !== 1) {
    throw new Error(`live field ${field.uuid || field.name} must have exactly one area`);
  }
  const submitter = submitters.find((entry) => entry.uuid === field.submitter_uuid);
  if (!submitter) throw new Error(`live field ${field.uuid || field.name} has an unknown submitter`);
  return [
    Number(area.page),
    numberKey(area.x),
    numberKey(area.y),
    numberKey(area.w),
    numberKey(area.h),
    field.type,
    ownerName(submitter.name),
  ].join('|');
}

export function matchGeneratedFields(generatedFields, liveTemplate) {
  const liveFields = liveTemplate.fields || [];
  const submitters = liveTemplate.submitters || [];
  if (generatedFields.length !== liveFields.length) {
    throw new Error(`field count mismatch: generated ${generatedFields.length}, live ${liveFields.length}`);
  }

  const liveByKey = new Map();
  for (const field of liveFields) {
    const key = liveFieldKey(field, submitters);
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
