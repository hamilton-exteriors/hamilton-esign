import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canonicalizeOnboardingExecutionPlan,
  hashOnboardingExecutionPlan,
  validateOnboardingExecutionPlan,
} from '../pipeline/onboarding-execution-plan.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const providerAttestation = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations.json', import.meta.url),
  'utf8',
));
const providerBindingBySlug = new Map(providerAttestation.entries.map((entry) => [entry.slug, entry.entrySha256]));

function doc(key, name, id, filingDestination, registry = null) {
  return {
    key,
    template: {
      id,
      name,
      ...(registry ? {
        registrySlug: registry.slug,
        registryVersion: registry.version,
        providerBindingSha256: providerBindingBySlug.get(registry.slug) || null,
      } : {}),
      documentSha256: A,
      snapshotSha256: B,
    },
    workerVisiblePrefills: { 'Worker Name': 'José Example', Rate: 22.5, Country: 'Philippines' },
    workerReadonlyFields: ['Worker Name'],
    hamiltonPrefills: { Employer: 'Hamilton Exteriors' },
    countersignRequired: true,
    filingDestination,
  };
}

function overseasPlan() {
  return {
    schemaVersion: 1,
    classification: 'overseas_contractor',
    stage: 'initial',
    language: 'en',
    recipient: { name: 'José Example', phone: '+639171234567', email: 'jose@example.com' },
    roleRelease: {
      roleKey: 'production-coordinator',
      version: '1.0',
      artifactRef: 'production-coordinator/1.0.md',
      sha256: A,
    },
    documents: [doc('contractor-agreement', 'Independent Contractor Agreement', 42, 'ContractorAgreements')],
    outboundWhatsApp: [
      {
        key: 'intro', kind: 'intro', textTemplate: 'Hi José, your onboarding is ready.', artifacts: [],
      },
      {
        key: 'agreement-link', kind: 'document-link', documentKey: 'contractor-agreement',
        textTemplate: 'Review and sign here: {{signing_url}}', artifacts: [],
      },
      {
        key: 'role-handout', kind: 'handout', textTemplate: 'Here are your role expectations.',
        artifacts: [{ key: 'role-expectations', filename: 'role-expectations.pdf', sha256: C, caption: 'Production Coordinator role expectations' }],
      },
    ],
    trainingEvidenceRequired: false,
  };
}

function w2InitialPlan() {
  return {
    schemaVersion: 3,
    classification: 'w2_local',
    stage: 'initial',
    language: 'en',
    recipient: { name: 'Example Worker', phone: '+14155552671', email: null },
    roleRelease: null,
    documents: [
      doc(
        'initial-packet',
        'W-2 Initial Employment Packet v3',
        380,
        'Personnel',
        { slug: 'w2-initial-packet-v3', version: 3 },
      ),
    ],
    outboundWhatsApp: [{
      key: 'initial-packet-link', kind: 'document-link', documentKey: 'initial-packet',
      textTemplate: 'Sign your initial packet: {{signing_url}}', artifacts: [],
    }],
    trainingEvidenceRequired: true,
  };
}

function legacyW2InitialPlan() {
  const plan = w2InitialPlan();
  plan.schemaVersion = 1;
  plan.documents = [
    doc('agreement', 'Employment Agreement', 1, 'Personnel'),
    doc('wage-notice', 'Wage Notice - Labor Code 2810.5', 2, 'Personnel'),
    doc('acknowledgment', 'New Hire Policy Acknowledgment', 3, 'Personnel'),
  ];
  plan.outboundWhatsApp = [{
    key: 'agreement-link', kind: 'document-link', documentKey: 'agreement',
    textTemplate: 'Sign the legacy packet: {{signing_url}}', artifacts: [],
  }];
  return plan;
}

function w2TrainingPlan() {
  const plan = w2InitialPlan();
  plan.stage = 'training';
  plan.documents = [doc(
    'safety-roster',
    'Safety Training Roster',
    4,
    'SafetyTrainingRosters',
    { slug: 'safety-training-roster', version: 1 },
  )];
  plan.outboundWhatsApp = [{
    key: 'safety-link', kind: 'document-link', documentKey: 'safety-roster',
    textTemplate: 'Acknowledge completed training: {{signing_url}}', artifacts: [],
  }];
  return plan;
}

function mutate(plan, mutation) {
  const copy = structuredClone(plan);
  mutation(copy);
  return copy;
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]));
  }
  return value;
}

test('canonical JSON sorts object keys, preserves ordered messages, and hashes UTF-8 bytes', () => {
  const plan = overseasPlan();
  const reversed = reverseObjectKeys(plan);
  assert.equal(canonicalizeOnboardingExecutionPlan(plan), canonicalizeOnboardingExecutionPlan(reversed));
  assert.equal(hashOnboardingExecutionPlan(plan).sha256, hashOnboardingExecutionPlan(reversed).sha256);

  const reordered = mutate(plan, (copy) => copy.outboundWhatsApp.reverse());
  assert.notEqual(hashOnboardingExecutionPlan(plan).sha256, hashOnboardingExecutionPlan(reordered).sha256);

  const result = hashOnboardingExecutionPlan(plan);
  assert.equal(result.sha256, createHash('sha256').update(Buffer.from(result.canonicalJson, 'utf8')).digest('hex'));
});

test('classification and stage enforce deferred W-2 training and exact document sets', () => {
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(w2InitialPlan()));
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(legacyW2InitialPlan()));
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(w2TrainingPlan()));
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(overseasPlan()));

  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(w2InitialPlan(), (copy) => copy.documents.push(w2TrainingPlan().documents[0]))),
    /ordered w2_local initial document set/,
  );
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(w2TrainingPlan(), (copy) => { copy.documents = w2InitialPlan().documents; })),
    /ordered w2_local training document set/,
  );
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(overseasPlan(), (copy) => { copy.stage = 'training'; })),
    /stage is unsupported for overseas_contractor/,
  );
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(overseasPlan(), (copy) => { copy.documents[0].key = 'initial-packet'; })),
    /ordered overseas_contractor initial document set/,
  );
});

test('schema v3 binds classification, stage, language, document key, and provider bytes to the exact registry template', () => {
  const spanish = mutate(w2InitialPlan(), (copy) => {
    copy.language = 'es';
    copy.documents[0].template.id = 381;
    copy.documents[0].template.name = 'Paquete Inicial de Empleo W-2 v3';
    copy.documents[0].template.registrySlug = 'w2-initial-packet-es-v3';
    copy.documents[0].template.providerBindingSha256 = providerBindingBySlug.get('w2-initial-packet-es-v3');
  });
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(spanish));

  const failures = [
    [mutate(w2InitialPlan(), (copy) => { copy.language = 'es'; }), /registrySlug must equal w2-initial-packet-es-v3/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.name = 'Paquete Inicial de Empleo W-2 v3'; }), /must equal registry title/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].key = 'safety-roster'; }), /ordered w2_local initial document set/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.registrySlug = 'safety-training-roster'; }), /registrySlug must equal w2-initial-packet-v3/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.registryVersion = 1; }), /registryVersion must equal 3/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.id = 999; }), /must equal attested provider template 380/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.providerBindingSha256 = C; }), /committed provider-byte attestation/],
    [mutate(w2InitialPlan(), (copy) => { delete copy.documents[0].template.registryVersion; }), /missing keys: registryVersion/],
  ];
  for (const [input, expected] of failures) assert.throws(() => validateOnboardingExecutionPlan(input), expected);
});

test('schema v1 and v2 compatibility is explicit and does not weaken schema v3', () => {
  const legacy = legacyW2InitialPlan();
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(legacy));
  const legacyV2 = w2InitialPlan();
  legacyV2.schemaVersion = 2;
  delete legacyV2.documents[0].template.providerBindingSha256;
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(legacyV2));
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(legacy, (copy) => {
      copy.documents[0].template.registrySlug = 'employment-agreement';
      copy.documents[0].template.registryVersion = 1;
    })),
    /unknown keys: registrySlug, registryVersion/,
  );
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(w2InitialPlan(), (copy) => {
      delete copy.documents[0].template.registrySlug;
      delete copy.documents[0].template.registryVersion;
    })),
    /missing keys: registrySlug, registryVersion/,
  );
});

test('per-document filing destinations are classification and stage specific', () => {
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(w2InitialPlan(), (copy) => { copy.documents[0].filingDestination = 'SafetyTrainingRosters'; })),
    /must equal Personnel for initial-packet/,
  );
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(w2TrainingPlan(), (copy) => { copy.documents[0].filingDestination = 'Personnel'; })),
    /must equal SafetyTrainingRosters for safety-roster/,
  );
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(overseasPlan(), (copy) => { copy.documents[0].filingDestination = 'Personnel'; })),
    /must equal ContractorAgreements for contractor-agreement/,
  );
});

test('recipient-visible values, decimal prefills, source digests, messages, and captions change the hash', () => {
  const plan = overseasPlan();
  const original = hashOnboardingExecutionPlan(plan).sha256;
  const changes = [
    ['recipient name', (copy) => { copy.recipient.name = 'Juan Example'; }],
    ['recipient phone', (copy) => { copy.recipient.phone = '+639181234567'; }],
    ['recipient email', (copy) => { copy.recipient.email = 'juan@example.com'; }],
    ['recipient email nullability', (copy) => { copy.recipient.email = null; }],
    ['decimal prefill', (copy) => { copy.documents[0].workerVisiblePrefills.Rate = 22.75; }],
    ['source document digest', (copy) => { copy.documents[0].template.documentSha256 = C; }],
    ['template snapshot digest', (copy) => { copy.documents[0].template.snapshotSha256 = C; }],
    ['message key', (copy) => { copy.outboundWhatsApp[0].key = 'welcome'; }],
    ['message text', (copy) => { copy.outboundWhatsApp[0].textTemplate += ' Welcome.'; }],
    ['artifact filename', (copy) => { copy.outboundWhatsApp[2].artifacts[0].filename = 'role-scope.pdf'; }],
    ['artifact digest', (copy) => { copy.outboundWhatsApp[2].artifacts[0].sha256 = B; }],
    ['artifact caption', (copy) => { copy.outboundWhatsApp[2].artifacts[0].caption += ' v1'; }],
    ['Hamilton prefill', (copy) => { copy.documents[0].hamiltonPrefills.Employer = 'ABR Quality Resources Inc'; }],
    ['countersign requirement', (copy) => { copy.documents[0].countersignRequired = false; }],
  ];
  for (const [label, change] of changes) {
    assert.notEqual(hashOnboardingExecutionPlan(mutate(plan, change)).sha256, original, label);
  }
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(plan));
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(plan, (copy) => { copy.documents[0].workerVisiblePrefills.Rate = -0; })),
    /finite number other than -0/,
  );
});

test('recipient identity enforces exact keys, E.164 classification, and optional valid email', () => {
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(overseasPlan()));
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(w2InitialPlan()));
  const failures = [
    [mutate(w2InitialPlan(), (copy) => { copy.recipient.phone = '+442071838750'; }), /must use a \+1 E\.164 number for w2_local/],
    [mutate(overseasPlan(), (copy) => { copy.recipient.phone = '+14155552671'; }), /must use a non-\+1 E\.164 number for overseas_contractor/],
    [mutate(overseasPlan(), (copy) => { copy.recipient.phone = '639171234567'; }), /invalid format/],
    [mutate(overseasPlan(), (copy) => { copy.recipient.phone = '+0123456789'; }), /invalid format/],
    [mutate(overseasPlan(), (copy) => { copy.recipient.email = 'not-an-email'; }), /invalid format/],
    [mutate(overseasPlan(), (copy) => { copy.recipient.email = ''; }), /non-empty/],
    [mutate(overseasPlan(), (copy) => { copy.recipient.slug = 'private'; }), /unknown keys: slug/],
    [mutate(overseasPlan(), (copy) => { copy.recipient.name = 'https://docuseal.example/s/private-slug'; }), /private signing URL/],
  ];
  for (const [input, expected] of failures) assert.throws(() => validateOnboardingExecutionPlan(input), expected);
});

test('schema v3 requires one ordered document-link message for every planned document', () => {
  const duplicateLink = structuredClone(w2InitialPlan().outboundWhatsApp[0]);
  duplicateLink.key = 'duplicate-initial-packet-link';
  const failures = [
    [mutate(w2InitialPlan(), (copy) => { copy.outboundWhatsApp = [{ key: 'intro', kind: 'intro', textTemplate: 'Welcome.', artifacts: [] }]; }), /map exactly once in document order: initial-packet/],
    [mutate(w2InitialPlan(), (copy) => { copy.outboundWhatsApp.push(duplicateLink); }), /map exactly once in document order: initial-packet/],
    [mutate(w2InitialPlan(), (copy) => { copy.outboundWhatsApp.unshift(duplicateLink); }), /map exactly once in document order: initial-packet/],
    [mutate(w2InitialPlan(), (copy) => { copy.outboundWhatsApp[0].documentKey = 'safety-roster'; }), /does not map to a document/],
    [mutate(w2InitialPlan(), (copy) => { copy.outboundWhatsApp[0].kind = 'intro'; delete copy.outboundWhatsApp[0].documentKey; copy.outboundWhatsApp[0].textTemplate = 'Welcome.'; }), /map exactly once in document order: initial-packet/],
  ];
  for (const [input, expected] of failures) assert.throws(() => validateOnboardingExecutionPlan(input), expected);

  // Schema v1 remains readable even though historical three-document plans carried one shared link.
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(legacyW2InitialPlan()));
});

test('outbound kinds enforce document mapping and literal signing placeholder rules', () => {
  const failures = [
    [mutate(overseasPlan(), (copy) => { delete copy.outboundWhatsApp[1].documentKey; }), /required for document-link/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[1].documentKey = 'agreement'; }), /does not map/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[1].textTemplate = 'Sign here now'; }), /exactly one literal/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[1].textTemplate = 'Sign: {{signing_url}} or {{signing_url}}'; }), /exactly one literal/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[1].textTemplate = 'Sign: {{signing_url}} https://example.com'; }), /not an actual URL/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[0].textTemplate = 'Unexpected {{signing_url}}'; }), /only allowed for document-link/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[0].documentKey = 'contractor-agreement'; }), /not allowed for intro/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[2].key = 'intro'; }), /duplicates intro/],
  ];
  for (const [input, expected] of failures) assert.throws(() => validateOnboardingExecutionPlan(input), expected);
});

test('rejects unknown keys, unsafe values, malformed hashes/refs, credentials, and private links', () => {
  const failures = [
    [mutate(overseasPlan(), (copy) => { copy.secret = 'nope'; }), /unknown keys: secret/],
    [mutate(overseasPlan(), (copy) => { copy.documents[0].template.token = 'nope'; }), /unknown keys: token/],
    [mutate(overseasPlan(), (copy) => { copy.documents[0].template.documentSha256 = 'ABC'; }), /invalid format/],
    [mutate(overseasPlan(), (copy) => { copy.roleRelease.artifactRef = '../private.md'; }), /invalid format/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[2].artifacts[0].filename = '../scope.pdf'; }), /invalid format/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[0].textTemplate = 'Sign at https://docuseal.example/s/private-slug'; }), /private signing URL/],
    [mutate(overseasPlan(), (copy) => { copy.outboundWhatsApp[0].textTemplate = 'Authorization: Bearer abc.def.secret'; }), /credentials/],
    [mutate(overseasPlan(), (copy) => { copy.documents[0].hamiltonPrefills.Employer = 'password=hunter2'; }), /credentials/],
  ];
  for (const [input, expected] of failures) assert.throws(() => validateOnboardingExecutionPlan(input), expected);
});
