import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_DIR = resolve(process.env.HAMILTON_BUILD_DIR || join(REPO_ROOT, 'build'));
export const DOCS_DIR = resolve(process.env.HAMILTON_DOCS_DIR ||
  join(homedir(), '.claude', 'skills', 'onboard-worker', 'references', 'documents'));
export const REFERENCES_DIR = resolve(DOCS_DIR, '..');
export const STATUTORY_DIR = resolve(process.env.HAMILTON_STATUTORY_DIR || join(REPO_ROOT, 'statutory'));
export const STATUTORY_LOCK_PATH = resolve(process.env.HAMILTON_STATUTORY_LOCK_PATH || join(STATUTORY_DIR, 'lock.json'));
export const OVERSEAS_ROLE_CATALOG_PATH = resolve(process.env.HAMILTON_OVERSEAS_ROLE_CATALOG_PATH ||
  join(REFERENCES_DIR, 'overseas-role-catalog.json'));
export const OVERSEAS_ROLE_ROOT = resolve(process.env.HAMILTON_OVERSEAS_ROLE_ROOT ||
  join(REFERENCES_DIR, 'roles'));
export const DOCUSEAL_SECRET_PATH = resolve(process.env.DOCUSEAL_SECRET_PATH ||
  join(homedir(), '.claude', '.hamilton-secrets', 'docuseal.json'));
export const PACKET_STATE_DIR = resolve(process.env.HAMILTON_PACKET_STATE_DIR ||
  join(homedir(), '.claude', '.hamilton-state', 'esign-packets'));
export const ONBOARDING_STATE_DIR = resolve(process.env.HAMILTON_ONBOARDING_STATE_DIR ||
  join(homedir(), '.claude', '.hamilton-state', 'onboarding'));

export function loadDocusealSecrets() {
  let value;
  try {
    value = JSON.parse(readFileSync(DOCUSEAL_SECRET_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read DocuSeal credentials at ${DOCUSEAL_SECRET_PATH}: ${error.message}`);
  }
  const missing = ['url', 'apiKey'].filter((key) => !value[key]);
  if (missing.length) {
    throw new Error(`DocuSeal credentials at ${DOCUSEAL_SECRET_PATH} are missing: ${missing.join(', ')}`);
  }
  value.url = value.url.replace(/\/+$/, '');
  value.publicUrl = (value.publicUrl || value.url).replace(/\/+$/, '');
  return value;
}
