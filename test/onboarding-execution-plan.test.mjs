import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  canonicalizeOnboardingExecutionPlan,
  hashOnboardingExecutionPlan,
  validateOnboardingExecutionPlan,
} from '../pipeline/onboarding-execution-plan.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function doc(key, name, id, filingDestination) {
  return {
    key,
    template: { id, name, documentSha256: A, snapshotSha256: B },
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
    schemaVersion: 1,
    classification: 'w2_local',
    stage: 'initial',
    language: 'en',
    recipient: { name: 'Example Worker', phone: '+14155552671', email: null },
    roleRelease: null,
    documents: [
      doc('agreement', 'Employment Agreement', 1, 'Personnel'),
      doc('wage-notice', 'Wage Notice - Labor Code 2810.5', 2, 'Personnel'),
      doc('acknowledgment', 'New Hire Policy Acknowledgment', 3, 'Personnel'),
    ],
    outboundWhatsApp: [{
      key: 'agreement-link', kind: 'document-link', documentKey: 'agreement',
      textTemplate: 'Sign your initial packet: {{signing_url}}', artifacts: [],
    }],
    trainingEvidenceRequired: true,
  };
}

function w2TrainingPlan() {
  const plan = w2InitialPlan();
  plan.stage = 'training';
  plan.documents = [doc('safety-roster', 'Safety Training Roster', 4, 'SafetyTrainingRosters')];
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
    () => validateOnboardingExecutionPlan(mutate(overseasPlan(), (copy) => { copy.documents = w2InitialPlan().documents; })),
    /ordered overseas_contractor initial document set/,
  );
});

test('per-document filing destinations are classification and stage specific', () => {
  assert.throws(
    () => validateOnboardingExecutionPlan(mutate(w2InitialPlan(), (copy) => { copy.documents[1].filingDestination = 'SafetyTrainingRosters'; })),
    /must equal Personnel for wage-notice/,
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
