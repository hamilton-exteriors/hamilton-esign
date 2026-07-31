import { statutorySources } from './statutory-assets.mjs';

export const BUILD_MANIFEST_SCHEMA_VERSION = 2;

export const TEMPLATE_REGISTRY = [
  { title: 'Independent Contractor Agreement', slug: 'independent-contractor-agreement', fields: 12, owners: { worker: 10, hamilton: 2 } },
  // Retained so existing separate-template submissions and snapshots remain readable.
  // New W-2 packets use the versioned composites below.
  { title: 'Employment Agreement', slug: 'employment-agreement', fields: 9, owners: { worker: 5, hamilton: 4 }, legacy: true },
  { title: 'Contrato de Empleo', slug: 'employment-agreement-es', fields: 9, owners: { worker: 5, hamilton: 4 }, legacy: true },
  { title: 'Wage Notice - Labor Code 2810.5', slug: 'wage-notice-2810-5', fields: 19, owners: { worker: 5, hamilton: 14 }, legacy: true },
  { title: 'Aviso de Salario - Código Laboral 2810.5', slug: 'wage-notice-2810-5-es', fields: 18, owners: { worker: 5, hamilton: 13 }, legacy: true },
  { title: 'New Hire Policy Acknowledgment', slug: 'policy-acknowledgment', fields: 34, owners: { worker: 31, hamilton: 3 }, legacy: true },
  { title: 'Acuse de Recibo de Políticas', slug: 'policy-acknowledgment-es', fields: 34, owners: { worker: 31, hamilton: 3 }, legacy: true },
  {
    title: 'W-2 Initial Employment Packet v2',
    slug: 'w2-initial-packet-v2',
    version: 2,
    fields: 62,
    owners: { worker: 41, hamilton: 21 },
    sources: [
      { kind: 'markdown', slug: 'employment-agreement' },
      { kind: 'markdown', slug: 'wage-notice-2810-5' },
      ...statutorySources('en'),
      { kind: 'markdown', slug: 'iipp' },
      { kind: 'markdown', slug: 'heat-illness-prevention-plan' },
      { kind: 'markdown', slug: 'fall-protection-program' },
      { kind: 'markdown', slug: 'code-of-safe-practices' },
      // This attests receipt of every preceding notice and program, so it must be last.
      { kind: 'markdown', slug: 'policy-acknowledgment' },
    ],
  },
  {
    title: 'Paquete Inicial de Empleo W-2 v2',
    slug: 'w2-initial-packet-es-v2',
    version: 2,
    fields: 61,
    owners: { worker: 41, hamilton: 20 },
    sources: [
      { kind: 'markdown', slug: 'employment-agreement-es' },
      { kind: 'markdown', slug: 'wage-notice-2810-5-es' },
      ...statutorySources('es'),
      { kind: 'markdown', slug: 'iipp-es' },
      { kind: 'markdown', slug: 'heat-illness-prevention-plan-es' },
      { kind: 'markdown', slug: 'fall-protection-program-es' },
      { kind: 'markdown', slug: 'code-of-safe-practices' },
      // This attests receipt of every preceding notice and program, so it must be last.
      { kind: 'markdown', slug: 'policy-acknowledgment-es' },
    ],
  },
  { title: 'Safety Training Roster', slug: 'safety-training-roster', fields: 65, owners: { worker: 54, hamilton: 11 } },
  { title: 'Registro de Capacitación en Seguridad', slug: 'safety-training-roster-es', fields: 65, owners: { worker: 54, hamilton: 11 } },
  { title: 'Injury and Illness Prevention Program (IIPP)', slug: 'iipp', fields: 5, owners: { hamilton: 5 } },
  { title: 'Programa de Prevención de Lesiones y Enfermedades (IIPP)', slug: 'iipp-es', fields: 5, owners: { hamilton: 5 } },
  { title: 'Heat Illness Prevention Plan', slug: 'heat-illness-prevention-plan', fields: 4, owners: { hamilton: 4 } },
  { title: 'Plan de Prevención de Enfermedades por Calor', slug: 'heat-illness-prevention-plan-es', fields: 4, owners: { hamilton: 4 } },
  { title: 'Fall Protection Program', slug: 'fall-protection-program', fields: 3, owners: { hamilton: 3 } },
  { title: 'Programa de Protección contra Caídas', slug: 'fall-protection-program-es', fields: 3, owners: { hamilton: 3 } },
  { title: 'Code of Safe Practices', slug: 'code-of-safe-practices', fields: 2, owners: { hamilton: 2 } },
];

export const CURRENT_TEMPLATE_REGISTRY = TEMPLATE_REGISTRY.filter((entry) => !entry.legacy);
export const TEMPLATE_BY_TITLE = new Map(TEMPLATE_REGISTRY.map((entry) => [entry.title, entry]));
export const TEMPLATE_BY_SLUG = new Map(TEMPLATE_REGISTRY.map((entry) => [entry.slug, entry]));
export const DEFAULT_DOCUMENT_SLUGS = CURRENT_TEMPLATE_REGISTRY
  .map((entry) => entry.slug);

export function orderedSources(entry) {
  const raw = entry.sources || [{ kind: 'markdown', slug: entry.slug }];
  return raw.map((source) => typeof source === 'string' ? { kind: 'markdown', slug: source } : { ...source });
}

export function sourceSlugs(entry) {
  return orderedSources(entry).map((source) => source.slug);
}

export function markdownSourceSlugs(entry) {
  return orderedSources(entry).filter((source) => source.kind === 'markdown').map((source) => source.slug);
}

export function requireUniqueActiveTemplate(templates, title) {
  const matches = templates.filter((template) => template.name === title && !template.archived_at);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one active template named "${title}", found ${matches.length}`);
  }
  return matches[0];
}
