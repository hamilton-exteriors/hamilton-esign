import { statutorySources } from './statutory-assets.mjs';

export const BUILD_MANIFEST_SCHEMA_VERSION = 3;

function w2PacketSources(language) {
  const es = language === 'es';
  return [
    { kind: 'markdown', slug: es ? 'employment-agreement-es' : 'employment-agreement' },
    { kind: 'markdown', slug: es ? 'wage-notice-2810-5-es' : 'wage-notice-2810-5' },
    ...statutorySources(language),
    { kind: 'markdown', slug: es ? 'iipp-es' : 'iipp' },
    { kind: 'markdown', slug: es ? 'heat-illness-prevention-plan-es' : 'heat-illness-prevention-plan' },
    { kind: 'markdown', slug: es ? 'fall-protection-program-es' : 'fall-protection-program' },
    { kind: 'markdown', slug: 'code-of-safe-practices' },
    // This attests receipt of every preceding notice and program, so it must be last.
    { kind: 'markdown', slug: es ? 'policy-acknowledgment-es' : 'policy-acknowledgment' },
  ];
}

export const TEMPLATE_REGISTRY = [
  { title: 'Independent Contractor Agreement', slug: 'independent-contractor-agreement', fields: 12, owners: { worker: 10, hamilton: 2 } },
  // Retained so existing separate-template submissions and snapshots remain readable.
  // New W-2 packets use the versioned composites below.
  { title: 'Employment Agreement', slug: 'employment-agreement', fields: 9, owners: { worker: 5, hamilton: 4 }, legacy: true },
  { title: 'Contrato de Empleo', slug: 'employment-agreement-es', fields: 9, owners: { worker: 5, hamilton: 4 }, legacy: true },
  { title: 'Wage Notice - Labor Code 2810.5', slug: 'wage-notice-2810-5', fields: 19, owners: { worker: 5, hamilton: 14 }, legacy: true },
  { title: 'Aviso de Salario - Código Laboral 2810.5', slug: 'wage-notice-2810-5-es', fields: 18, owners: { worker: 5, hamilton: 13 }, legacy: true },
  { title: 'New Hire Policy Acknowledgment', slug: 'policy-acknowledgment', fields: 34, owners: { worker: 31, hamilton: 3 }, legacy: true, liveFields: 33, liveOwners: { worker: 30, hamilton: 3 } },
  { title: 'Acuse de Recibo de Políticas', slug: 'policy-acknowledgment-es', fields: 34, owners: { worker: 31, hamilton: 3 }, legacy: true, liveFields: 33, liveOwners: { worker: 30, hamilton: 3 } },
  {
    title: 'W-2 Initial Employment Packet v2',
    slug: 'w2-initial-packet-v2',
    version: 2,
    fields: 62,
    owners: { worker: 41, hamilton: 21 },
    sources: w2PacketSources('en'),
    legacy: true,
    providerDocuments: 1,
    pageCount: 82,
  },
  {
    title: 'Paquete Inicial de Empleo W-2 v2',
    slug: 'w2-initial-packet-es-v2',
    version: 2,
    fields: 61,
    owners: { worker: 41, hamilton: 20 },
    sources: w2PacketSources('es'),
    legacy: true,
    providerDocuments: 1,
    pageCount: 87,
  },
  {
    title: 'W-2 Initial Employment Packet v3',
    slug: 'w2-initial-packet-v3',
    version: 3,
    fields: 62,
    owners: { worker: 41, hamilton: 21 },
    sources: w2PacketSources('en'),
    providerDocuments: 15,
    pageCount: 82,
    orderedSourceAttachments: true,
  },
  {
    title: 'Paquete Inicial de Empleo W-2 v3',
    slug: 'w2-initial-packet-es-v3',
    version: 3,
    fields: 61,
    owners: { worker: 41, hamilton: 20 },
    sources: w2PacketSources('es'),
    providerDocuments: 15,
    pageCount: 87,
    orderedSourceAttachments: true,
  },
  { title: 'Safety Training Roster', slug: 'safety-training-roster', fields: 65, owners: { worker: 54, hamilton: 11 } },
  { title: 'Registro de Capacitación en Seguridad', slug: 'safety-training-roster-es', fields: 65, owners: { worker: 54, hamilton: 11 } },
  { title: 'Injury and Illness Prevention Program (IIPP)', slug: 'iipp', fields: 5, owners: { hamilton: 5 } },
  // Spanish IIPP/fall sources are embedded in the composite. No separate live
  // templates were released, so keep these identities only for legacy/source lookup.
  { title: 'Programa de Prevención de Lesiones y Enfermedades (IIPP)', slug: 'iipp-es', fields: 5, owners: { hamilton: 5 }, sourceOnly: true, liveExpected: false },
  { title: 'Heat Illness Prevention Plan', slug: 'heat-illness-prevention-plan', fields: 4, owners: { hamilton: 4 } },
  { title: 'Plan de Prevención de Enfermedades por Calor', slug: 'heat-illness-prevention-plan-es', fields: 4, owners: { hamilton: 4 } },
  { title: 'Fall Protection Program', slug: 'fall-protection-program', fields: 3, owners: { hamilton: 3 } },
  { title: 'Programa de Protección contra Caídas', slug: 'fall-protection-program-es', fields: 3, owners: { hamilton: 3 }, sourceOnly: true, liveExpected: false },
  { title: 'Code of Safe Practices', slug: 'code-of-safe-practices', fields: 2, owners: { hamilton: 2 } },
];

export const SOURCE_ONLY_TEMPLATE_REGISTRY = TEMPLATE_REGISTRY.filter((entry) => entry.sourceOnly);
export const RETAINED_LEGACY_TEMPLATE_REGISTRY = TEMPLATE_REGISTRY
  .filter((entry) => entry.legacy && !entry.sourceOnly);
export const CURRENT_TEMPLATE_REGISTRY = TEMPLATE_REGISTRY
  .filter((entry) => !entry.legacy && entry.liveExpected !== false && !entry.sourceOnly);
export const STAMP_TEMPLATE_REGISTRY = CURRENT_TEMPLATE_REGISTRY;
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
