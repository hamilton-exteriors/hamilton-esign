const PRIVATE_KEY = /(?:^|_)(?:link|url|token|secret|password|cookie|api_?key)(?:$|_)|(?:Link|Url|URL|Token|Secret|Password|Cookie|ApiKey)/;
const PRIVATE_VALUE = /https?:\/\/\S+/i;
const SHA256 = /^[a-f0-9]{64}$/;
const META_REF = /^meta:[A-Za-z0-9._:-]{6,240}$/;
const DRIVE_REF = /^drive:[A-Za-z0-9_-]{10,256}$/;

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

function assertSuccessProof(proof) {
  if (!exactKeys(proof, ['kind', 'providerResultReference', 'signedDocument', 'contentSha256'])) {
    throw new Error('effect success proof is malformed');
  }
  if (proof.kind === 'meta_message') {
    if (!META_REF.test(proof.providerResultReference || '') || 'contentSha256' in proof) throw new Error('Meta success proof is malformed');
    if (proof.signedDocument !== undefined && (!exactKeys(proof.signedDocument, ['idReference', 'sha256']) ||
      typeof proof.signedDocument.idReference !== 'string' || !proof.signedDocument.idReference || !SHA256.test(proof.signedDocument.sha256 || ''))) {
      throw new Error('Meta signed-document proof is malformed');
    }
    return;
  }
  if (proof.kind === 'drive_file') {
    if (!DRIVE_REF.test(proof.providerResultReference || '') || !SHA256.test(proof.contentSha256 || '') || 'signedDocument' in proof) {
      throw new Error('Drive success proof is malformed');
    }
    return;
  }
  throw new Error('effect success proof kind is unsupported');
}

export function platformCutoverEnabled(env = process.env) {
  return env.HAMILTON_PLATFORM_ONBOARDING_CUTOVER === 'true';
}

function configuration(env = process.env) {
  const url = env.PLATFORM_INTERNAL_URL?.replace(/\/+$/, '');
  const token = env.PLATFORM_INTERNAL_TOKEN;
  if (!url || !token) throw new Error('Platform cutover requires PLATFORM_INTERNAL_URL and PLATFORM_INTERNAL_TOKEN');
  return { url, token };
}

function assertSanitized(value, path = 'Platform response') {
  if (Array.isArray(value)) return value.forEach((item, i) => assertSanitized(item, `${path}[${i}]`));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && PRIVATE_VALUE.test(value)) throw new Error(`${path} contains private signing data`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) throw new Error(`${path}.${key} is not permitted`);
    assertSanitized(child, `${path}.${key}`);
  }
}

export class PlatformOnboardingClient {
  constructor({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
    this.fetch = fetchImpl;
    this.config = configuration(env);
  }

  async request(path, method = 'GET', body) {
    const response = await this.fetch(`${this.config.url}/internal/onboarding${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => ({}));
    assertSanitized(json);
    if (!response.ok) throw new Error(typeof json.error === 'string' && json.error ? json.error : `Platform onboarding request failed (${response.status})`);
    return json;
  }

  create(type, intake) { return this.request('', 'POST', { type, intake }); }
  status(id) { return this.request(`/${encodeURIComponent(id)}/status`); }
  plan(id, stage = 'initial') { return this.request(`/${encodeURIComponent(id)}/plan?stage=${encodeURIComponent(stage)}`); }
  approveCopy(id, planId, stage, copyHash, approvalReference) {
    return this.request(`/${encodeURIComponent(id)}/approve-copy`, 'POST', { planId, stage, copyHash, approvalReference });
  }
  recordGate(id, gate, evidenceReference) {
    return this.request(`/${encodeURIComponent(id)}/gates`, 'POST', { gate, evidenceReference });
  }
  rebindRole(id, roleKey, releaseVersion) {
    return this.request(`/${encodeURIComponent(id)}/rebind-role`, 'POST', { roleKey, releaseVersion });
  }
  start(id, planId, stage, digest) {
    return this.request(`/${encodeURIComponent(id)}/start`, 'POST', { planId, stage, digest });
  }
  reconcile(id) { return this.request(`/${encodeURIComponent(id)}/reconcile`, 'POST'); }
  importLegacy(record, { dryRun = true } = {}) {
    return this.request('/import', 'POST', { record, dryRun });
  }
  resolveEffect(id, idempotencyKey, outcome, evidenceReference, successProof) {
    if (outcome === 'succeeded') assertSuccessProof(successProof);
    else if (outcome !== 'definite_failed' || successProof !== undefined) throw new Error('effect resolution outcome is malformed');
    return this.request(`/${encodeURIComponent(id)}/effects/resolve`, 'POST', {
      idempotencyKey,
      outcome,
      evidenceReference,
      ...(outcome === 'succeeded' ? { successProof } : {}),
    });
  }
  registerDocument(id, document) {
    return this.request(`/${encodeURIComponent(id)}/documents`, 'POST', { document });
  }
  auditCountersignOpen(id, submissionRef) {
    return this.request(`/${encodeURIComponent(id)}/countersign-open`, 'POST', { submissionRef });
  }
}

export function createPlatformOnboardingClient(options) {
  return new PlatformOnboardingClient(options);
}
