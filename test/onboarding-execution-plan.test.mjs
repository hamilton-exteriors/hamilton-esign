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
const retainedV2ProviderAttestation = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations-v2.json', import.meta.url),
  'utf8',
));
const legacyProviderAttestation = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations-v1.json', import.meta.url),
  'utf8',
));
const currentEntryBySlug = new Map(providerAttestation.entries.map((entry) => [entry.slug, entry]));
const retainedV2BindingBySlug = new Map(retainedV2ProviderAttestation.entries.map((entry) => [entry.slug, entry.entrySha256]));
const legacyProviderBindingBySlug = new Map(legacyProviderAttestation.entries.map((entry) => [entry.slug, entry.entrySha256]));
// Before the v4 provider capture lands, the live attestation file still holds the
// v3 generation and every schema-5 initial-packet plan must fail closed. The
// committed release state holds the v4 entries, so at HEAD the full positive
// battery below runs.
const v4EnEntry = currentEntryBySlug.get('w2-initial-packet-v4') || null;
const v4EsEntry = currentEntryBySlug.get('w2-initial-packet-es-v4') || null;
const v4Captured = Boolean(v4EnEntry && v4EsEntry);

function doc(key, name, id, filingDestination, registry = null) {
  return {
    key,
    template: {
      id,
      name,
      ...(registry ? {
        registrySlug: registry.slug,
        registryVersion: registry.version,
        providerBindingSha256: registry.binding ?? null,
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

function assertCurrentInitialPlanState(plan) {
  if (v4Captured) assert.doesNotThrow(() => validateOnboardingExecutionPlan(plan));
  else assert.throws(() => validateOnboardingExecutionPlan(plan), /no unique entry for w2-initial-packet(?:-es)?-v4/);
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
    schemaVersion: 5,
    classification: 'w2_local',
    stage: 'initial',
    language: 'en',
    recipient: { name: 'Example Worker', phone: '+14155552671', email: null },
    roleRelease: null,
    documents: [
      doc(
        'initial-packet',
        'W-2 Initial Employment Packet v4',
        v4EnEntry ? Number(v4EnEntry.templateId) : 999,
        'Personnel',
        { slug: 'w2-initial-packet-v4', version: 4, binding: v4EnEntry?.entrySha256 ?? C },
      ),
    ],
    outboundWhatsApp: [{
      key: 'initial-packet-link', kind: 'document-link', documentKey: 'initial-packet',
      textTemplate: 'Sign your initial packet: {{signing_url}}', artifacts: [],
    }],
    trainingEvidenceRequired: true,
  };
}

// Retained schema 4: the v3 packet bound to the immutable gen-C retention file.
function retainedGenCW2InitialPlan() {
  const plan = w2InitialPlan();
  plan.schemaVersion = 4;
  plan.documents[0].template.id = 380;
  plan.documents[0].template.name = 'W-2 Initial Employment Packet v3';
  plan.documents[0].template.registrySlug = 'w2-initial-packet-v3';
  plan.documents[0].template.registryVersion = 3;
  plan.documents[0].template.providerBindingSha256 = retainedV2BindingBySlug.get('w2-initial-packet-v3');
  return plan;
}

// Retained schema 3: the v3 packet bound to the immutable gen-A v1 file.
function retainedW2InitialPlan() {
  const plan = retainedGenCW2InitialPlan();
  plan.schemaVersion = 3;
  plan.documents[0].template.providerBindingSha256 = legacyProviderBindingBySlug.get('w2-initial-packet-v3');
  return plan;
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
  assertCurrentInitialPlanState(w2InitialPlan());
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(retainedGenCW2InitialPlan()));
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(retainedW2InitialPlan()));
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

test('schema v5 binds classification, stage, language, document key, and provider bytes to the exact v4 registry template', () => {
  const spanish = mutate(w2InitialPlan(), (copy) => {
    copy.language = 'es';
    copy.documents[0].template.id = v4EsEntry ? Number(v4EsEntry.templateId) : 998;
    copy.documents[0].template.name = 'Paquete Inicial de Empleo W-2 v4';
    copy.documents[0].template.registrySlug = 'w2-initial-packet-es-v4';
    copy.documents[0].template.providerBindingSha256 = v4EsEntry?.entrySha256 ?? C;
  });
  assertCurrentInitialPlanState(spanish);

  // These reject before any attestation lookup, so they hold in both the
  // pre-capture and released states.
  const failures = [
    [mutate(w2InitialPlan(), (copy) => { copy.language = 'es'; }), /registrySlug must equal w2-initial-packet-es-v4/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.name = 'Paquete Inicial de Empleo W-2 v3'; }), /must equal registry title/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].key = 'safety-roster'; }), /ordered w2_local initial document set/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.registrySlug = 'safety-training-roster'; }), /registrySlug must equal w2-initial-packet-v4/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.registrySlug = 'w2-initial-packet-v3'; }), /registrySlug must equal w2-initial-packet-v4/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.registryVersion = 3; }), /registryVersion must equal 4/],
    [mutate(w2InitialPlan(), (copy) => { delete copy.documents[0].template.registryVersion; }), /missing keys: registryVersion/],
  ];
  for (const [input, expected] of failures) assert.throws(() => validateOnboardingExecutionPlan(input), expected);

  // Exact provider binding is only checkable once the v4 attestation is
  // captured; before that the same plans fail closed at the entry lookup.
  const bindingFailures = [
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.id = 999999; }), /must equal attested provider template \d+/],
    [mutate(w2InitialPlan(), (copy) => { copy.documents[0].template.providerBindingSha256 = C; }), /committed provider-byte attestation/],
  ];
  for (const [input, expected] of bindingFailures) {
    assert.throws(
      () => validateOnboardingExecutionPlan(input),
      v4Captured ? expected : /no unique entry for w2-initial-packet-v4/,
    );
  }
});

test('schema v1, v2, and retained v3/v4 compatibility is explicit and does not weaken schema v5', () => {
  const legacy = legacyW2InitialPlan();
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(legacy));
  const legacyV2 = w2InitialPlan();
  legacyV2.schemaVersion = 2;
  delete legacyV2.documents[0].template.providerBindingSha256;
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(legacyV2));

  // Retained schema 3 binds gen-A (v1 file); retained schema 4 binds gen-C
  // (immutable v2 retention file). Neither accepts the other generation's
  // digests, and both keep resolving the legacy v3 registry identity.
  const retained = retainedW2InitialPlan();
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(retained));
  const retainedGenC = retainedGenCW2InitialPlan();
  assert.doesNotThrow(() => validateOnboardingExecutionPlan(retainedGenC));
  assert.throws(() => validateOnboardingExecutionPlan(mutate(retained, (copy) => {
    copy.documents[0].template.providerBindingSha256 = retainedV2BindingBySlug.get('w2-initial-packet-v3');
  })), /committed provider-byte attestation/);
  assert.throws(() => validateOnboardingExecutionPlan(mutate(retainedGenC, (copy) => {
    copy.documents[0].template.providerBindingSha256 = legacyProviderBindingBySlug.get('w2-initial-packet-v3');
  })), /committed provider-byte attestation/);
  assert.throws(() => validateOnboardingExecutionPlan(mutate(retainedGenC, (copy) => {
    copy.documents[0].template.providerBindingSha256 = C;
  })), /committed provider-byte attestation/);
  // A retained schema must not reach forward to the v4 identity, and the
  // current schema must not reach back to v3.
  assert.throws(() => validateOnboardingExecutionPlan(mutate(retainedGenC, (copy) => {
    copy.documents[0].template.registrySlug = 'w2-initial-packet-v4';
    copy.documents[0].template.registryVersion = 4;
  })), /registrySlug must equal w2-initial-packet-v3/);
  assert.throws(() => validateOnboardingExecutionPlan(mutate(w2InitialPlan(), (copy) => {
    copy.documents[0].template.registrySlug = 'w2-initial-packet-v3';
    copy.documents[0].template.registryVersion = 3;
  })), /registrySlug must equal w2-initial-packet-v4/);
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(w2InitialPlan(), (copy) => {
      copy.documents[0].template.providerBindingSha256 = legacyProviderBindingBySlug.get('w2-initial-packet-v3');
    })),
    v4Captured ? /committed provider-byte attestation/ : /no unique entry for w2-initial-packet-v4/,
  );
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
  assertCurrentInitialPlanState(w2InitialPlan());
  // Recipient checks run after template binding, so exercise them on the
  // always-valid retained fixture.
  const failures = [
    [mutate(retainedGenCW2InitialPlan(), (copy) => { copy.recipient.phone = '+442071838750'; }), /must use a \+1 E\.164 number for w2_local/],
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

test('provider-attested schemas require one ordered document-link message for every planned document', () => {
  // The exact-link rule runs after template binding, so exercise it on the
  // always-valid retained provider-attested fixture; it applies identically to
  // schemas 3, 4, and 5.
  const duplicateLink = structuredClone(retainedGenCW2InitialPlan().outboundWhatsApp[0]);
  duplicateLink.key = 'duplicate-initial-packet-link';
  const failures = [
    [mutate(retainedGenCW2InitialPlan(), (copy) => { copy.outboundWhatsApp = [{ key: 'intro', kind: 'intro', textTemplate: 'Welcome.', artifacts: [] }]; }), /map exactly once in document order: initial-packet/],
    [mutate(retainedGenCW2InitialPlan(), (copy) => { copy.outboundWhatsApp.push(duplicateLink); }), /map exactly once in document order: initial-packet/],
    [mutate(retainedGenCW2InitialPlan(), (copy) => { copy.outboundWhatsApp.unshift(duplicateLink); }), /map exactly once in document order: initial-packet/],
    [mutate(retainedGenCW2InitialPlan(), (copy) => { copy.outboundWhatsApp[0].documentKey = 'safety-roster'; }), /does not map to a document/],
    [mutate(retainedGenCW2InitialPlan(), (copy) => { copy.outboundWhatsApp[0].kind = 'intro'; delete copy.outboundWhatsApp[0].documentKey; copy.outboundWhatsApp[0].textTemplate = 'Welcome.'; }), /map exactly once in document order: initial-packet/],
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
