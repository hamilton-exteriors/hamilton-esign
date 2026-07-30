import { createHash } from 'node:crypto';

export const ONBOARDING_EXECUTION_PLAN_SCHEMA_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLE_VERSION = /^\d+\.\d+(?:\.\d+)?$/;
const ROLE_ARTIFACT_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*\/\d+\.\d+(?:\.\d+)?\.md$/;
const FIELD_REF = /^[A-Za-z][A-Za-z0-9 _.-]{0,127}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,127}\.[A-Za-z0-9]{1,10}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const SIGNING_URL_PLACEHOLDER = '{{signing_url}}';

const CLASSIFICATION_RULES = {
  w2_local: {
    stages: {
      initial: {
        languages: ['en', 'es'],
        documents: ['agreement', 'wage-notice', 'acknowledgment'],
        destinations: ['Personnel', 'Personnel', 'Personnel'],
      },
      training: {
        languages: ['en', 'es'],
        documents: ['safety-roster'],
        destinations: ['SafetyTrainingRosters'],
      },
    },
    trainingEvidenceRequired: true,
    roleRelease: false,
  },
  overseas_contractor: {
    stages: {
      initial: {
        languages: ['en'],
        documents: ['contractor-agreement'],
        destinations: ['ContractorAgreements'],
      },
    },
    trainingEvidenceRequired: false,
    roleRelease: true,
  },
};

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

function exactKeys(value, keys, path) {
  object(value, path);
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) fail(path, `contains unknown keys: ${unknown.join(', ')}`);
  if (missing.length) fail(path, `is missing keys: ${missing.join(', ')}`);
}

function rejectSensitiveString(value, path) {
  const forbidden = [
    /(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
    /\b(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|password)\s*[:=]\s*\S+/i,
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /https?:\/\/[^\s]*(?:docuseal|sign)[^\s]*(?:\/s\/|\/sign\/|slug=|token=)[^\s]*/i,
  ];
  if (forbidden.some((pattern) => pattern.test(value))) {
    fail(path, 'must not contain credentials or a private signing URL/slug');
  }
}

function safeString(value, path, { pattern, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if ((!allowEmpty && value.length === 0) || value !== value.trim()) fail(path, 'must be non-empty and have no surrounding whitespace');
  if (value !== value.normalize('NFC')) fail(path, 'must use NFC Unicode normalization');
  if (/\p{Cc}|\p{Cs}/u.test(value)) fail(path, 'contains control or surrogate characters');
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  rejectSensitiveString(value, path);
  return value;
}

function digest(value, path) {
  return safeString(value, path, { pattern: SHA256 });
}

function scalar(value, path) {
  if (typeof value === 'string') return safeString(value, path, { allowEmpty: true });
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  fail(path, 'must be a string, boolean, null, or finite number other than -0');
}

function recipient(value, classification, path) {
  exactKeys(value, ['name', 'phone', 'email'], path);
  const name = safeString(value.name, `${path}.name`);
  if (name.length > 200) fail(`${path}.name`, 'must not exceed 200 characters');
  const phone = safeString(value.phone, `${path}.phone`, { pattern: E164 });
  if (classification === 'w2_local' && !phone.startsWith('+1')) {
    fail(`${path}.phone`, 'must use a +1 E.164 number for w2_local');
  }
  if (classification === 'overseas_contractor' && phone.startsWith('+1')) {
    fail(`${path}.phone`, 'must use a non-+1 E.164 number for overseas_contractor');
  }
  let email = null;
  if (value.email !== null) {
    email = safeString(value.email, `${path}.email`, { pattern: EMAIL });
    if (email.length > 254) fail(`${path}.email`, 'must not exceed 254 characters');
  }
  return { name, phone, email };
}

function prefills(value, path) {
  object(value, path);
  const result = {};
  for (const key of Object.keys(value)) {
    safeString(key, `${path} key`, { pattern: FIELD_REF });
    result[key] = scalar(value[key], `${path}.${key}`);
  }
  return result;
}

function roleRelease(value, required, path) {
  if (!required) {
    if (value !== null) fail(path, 'must be null for w2_local');
    return null;
  }
  exactKeys(value, ['roleKey', 'version', 'artifactRef', 'sha256'], path);
  return {
    roleKey: safeString(value.roleKey, `${path}.roleKey`, { pattern: SAFE_KEY }),
    version: safeString(value.version, `${path}.version`, { pattern: ROLE_VERSION }),
    artifactRef: safeString(value.artifactRef, `${path}.artifactRef`, { pattern: ROLE_ARTIFACT_REF }),
    sha256: digest(value.sha256, `${path}.sha256`),
  };
}

function template(value, path) {
  exactKeys(value, ['id', 'name', 'documentSha256', 'snapshotSha256'], path);
  if (!Number.isSafeInteger(value.id) || value.id <= 0) fail(`${path}.id`, 'must be a positive safe integer');
  return {
    id: value.id,
    name: safeString(value.name, `${path}.name`),
    documentSha256: digest(value.documentSha256, `${path}.documentSha256`),
    snapshotSha256: digest(value.snapshotSha256, `${path}.snapshotSha256`),
  };
}

function document(value, path) {
  exactKeys(value, [
    'key', 'template', 'workerVisiblePrefills', 'workerReadonlyFields',
    'hamiltonPrefills', 'countersignRequired', 'filingDestination',
  ], path);
  const workerVisiblePrefills = prefills(value.workerVisiblePrefills, `${path}.workerVisiblePrefills`);
  if (!Array.isArray(value.workerReadonlyFields)) fail(`${path}.workerReadonlyFields`, 'must be an array');
  const seen = new Set();
  const workerReadonlyFields = value.workerReadonlyFields.map((field, index) => {
    const result = safeString(field, `${path}.workerReadonlyFields[${index}]`, { pattern: FIELD_REF });
    if (seen.has(result)) fail(`${path}.workerReadonlyFields`, `duplicates ${result}`);
    if (!Object.hasOwn(workerVisiblePrefills, result)) fail(`${path}.workerReadonlyFields`, `references non-prefilled field ${result}`);
    seen.add(result);
    return result;
  });
  if (typeof value.countersignRequired !== 'boolean') fail(`${path}.countersignRequired`, 'must be boolean');
  return {
    key: safeString(value.key, `${path}.key`, { pattern: SAFE_KEY }),
    template: template(value.template, `${path}.template`),
    workerVisiblePrefills,
    workerReadonlyFields,
    hamiltonPrefills: prefills(value.hamiltonPrefills, `${path}.hamiltonPrefills`),
    countersignRequired: value.countersignRequired,
    filingDestination: safeString(value.filingDestination, `${path}.filingDestination`, { pattern: /^[A-Za-z][A-Za-z0-9]*$/ }),
  };
}

function artifact(value, path) {
  exactKeys(value, ['key', 'filename', 'sha256', 'caption'], path);
  return {
    key: safeString(value.key, `${path}.key`, { pattern: SAFE_KEY }),
    filename: safeString(value.filename, `${path}.filename`, { pattern: FILENAME }),
    sha256: digest(value.sha256, `${path}.sha256`),
    caption: safeString(value.caption, `${path}.caption`),
  };
}

function outbound(value, path, documentKeys) {
  const hasDocumentKey = Object.hasOwn(object(value, path), 'documentKey');
  exactKeys(value, hasDocumentKey ? ['key', 'kind', 'documentKey', 'textTemplate', 'artifacts'] : ['key', 'kind', 'textTemplate', 'artifacts'], path);
  const key = safeString(value.key, `${path}.key`, { pattern: SAFE_KEY });
  const kind = safeString(value.kind, `${path}.kind`, { pattern: SAFE_KEY });
  if (!['intro', 'document-link', 'handout', 'executed-copy'].includes(kind)) fail(`${path}.kind`, 'is unsupported');
  const requiresDocument = kind === 'document-link' || kind === 'executed-copy';
  if (requiresDocument !== hasDocumentKey) {
    fail(`${path}.documentKey`, requiresDocument ? `is required for ${kind}` : `is not allowed for ${kind}`);
  }
  let documentKey;
  if (hasDocumentKey) {
    documentKey = safeString(value.documentKey, `${path}.documentKey`, { pattern: SAFE_KEY });
    if (!documentKeys.has(documentKey)) fail(`${path}.documentKey`, 'does not map to a document in this plan');
  }
  const textTemplate = safeString(value.textTemplate, `${path}.textTemplate`);
  const placeholders = textTemplate.split(SIGNING_URL_PLACEHOLDER).length - 1;
  if (kind === 'document-link') {
    if (placeholders !== 1) fail(`${path}.textTemplate`, `must contain exactly one literal ${SIGNING_URL_PLACEHOLDER} placeholder`);
    if (/https?:\/\//i.test(textTemplate)) fail(`${path}.textTemplate`, 'must use the signing URL placeholder, not an actual URL');
  } else if (placeholders !== 0) {
    fail(`${path}.textTemplate`, `${SIGNING_URL_PLACEHOLDER} is only allowed for document-link messages`);
  }
  if (!Array.isArray(value.artifacts)) fail(`${path}.artifacts`, 'must be an array');
  const seenArtifacts = new Set();
  const artifacts = value.artifacts.map((entry, index) => {
    const result = artifact(entry, `${path}.artifacts[${index}]`);
    if (seenArtifacts.has(result.key)) fail(`${path}.artifacts`, `duplicates ${result.key}`);
    seenArtifacts.add(result.key);
    return result;
  });
  return { key, kind, ...(hasDocumentKey ? { documentKey } : {}), textTemplate, artifacts };
}

export function validateOnboardingExecutionPlan(input) {
  const path = 'plan';
  exactKeys(input, [
    'schemaVersion', 'classification', 'stage', 'language', 'recipient', 'roleRelease', 'documents',
    'outboundWhatsApp', 'trainingEvidenceRequired',
  ], path);
  if (input.schemaVersion !== ONBOARDING_EXECUTION_PLAN_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `must equal ${ONBOARDING_EXECUTION_PLAN_SCHEMA_VERSION}`);
  }
  const classification = safeString(input.classification, `${path}.classification`, { pattern: /^[a-z][a-z0-9_]*$/ });
  const classificationRules = CLASSIFICATION_RULES[classification];
  if (!classificationRules) fail(`${path}.classification`, 'is unsupported');
  const stage = safeString(input.stage, `${path}.stage`, { pattern: SAFE_KEY });
  const rules = classificationRules.stages[stage];
  if (!rules) fail(`${path}.stage`, `is unsupported for ${classification}`);
  const language = safeString(input.language, `${path}.language`, { pattern: /^[a-z]{2}$/ });
  if (!rules.languages.includes(language)) fail(`${path}.language`, `is unsupported for ${classification} ${stage}`);
  if (!Array.isArray(input.documents)) fail(`${path}.documents`, 'must be an array');
  const documents = input.documents.map((entry, index) => document(entry, `${path}.documents[${index}]`));
  const keys = documents.map((entry) => entry.key);
  if (keys.length !== rules.documents.length || keys.some((key, index) => key !== rules.documents[index])) {
    fail(`${path}.documents`, `must use the ordered ${classification} ${stage} document set: ${rules.documents.join(', ')}`);
  }
  documents.forEach((entry, index) => {
    if (entry.filingDestination !== rules.destinations[index]) {
      fail(`${path}.documents[${index}].filingDestination`, `must equal ${rules.destinations[index]} for ${entry.key}`);
    }
  });
  if (!Array.isArray(input.outboundWhatsApp) || input.outboundWhatsApp.length === 0) {
    fail(`${path}.outboundWhatsApp`, 'must be a non-empty array');
  }
  const seenOutbound = new Set();
  const documentKeys = new Set(keys);
  const outboundWhatsApp = input.outboundWhatsApp.map((entry, index) => {
    const result = outbound(entry, `${path}.outboundWhatsApp[${index}]`, documentKeys);
    if (seenOutbound.has(result.key)) fail(`${path}.outboundWhatsApp`, `duplicates ${result.key}`);
    seenOutbound.add(result.key);
    return result;
  });
  if (input.trainingEvidenceRequired !== classificationRules.trainingEvidenceRequired) {
    fail(`${path}.trainingEvidenceRequired`, `must equal ${classificationRules.trainingEvidenceRequired} for ${classification}`);
  }
  return {
    schemaVersion: ONBOARDING_EXECUTION_PLAN_SCHEMA_VERSION,
    classification,
    stage,
    language,
    recipient: recipient(input.recipient, classification, `${path}.recipient`),
    roleRelease: roleRelease(input.roleRelease, classificationRules.roleRelease, `${path}.roleRelease`),
    documents,
    outboundWhatsApp,
    trainingEvidenceRequired: input.trainingEvidenceRequired,
  };
}

function recursivelySort(value) {
  if (Array.isArray(value)) return value.map(recursivelySort);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, recursivelySort(value[key])]));
  }
  return value;
}

export function canonicalizeOnboardingExecutionPlan(input) {
  return JSON.stringify(recursivelySort(validateOnboardingExecutionPlan(input)));
}

export function hashOnboardingExecutionPlan(input) {
  const canonicalJson = canonicalizeOnboardingExecutionPlan(input);
  const sha256 = createHash('sha256').update(Buffer.from(canonicalJson, 'utf8')).digest('hex');
  return { canonicalJson, sha256 };
}
