export const TEMPLATE_REGISTRY = [
  { title: 'Independent Contractor Agreement', slug: 'independent-contractor-agreement', fields: 12, owners: { worker: 10, hamilton: 2 } },
  { title: 'Employment Agreement', slug: 'employment-agreement', fields: 9, owners: { worker: 5, hamilton: 4 } },
  { title: 'Contrato de Empleo', slug: 'employment-agreement-es', fields: 9, owners: { worker: 5, hamilton: 4 } },
  { title: 'Wage Notice - Labor Code 2810.5', slug: 'wage-notice-2810-5', fields: 19, owners: { worker: 5, hamilton: 14 } },
  { title: 'Aviso de Salario - Código Laboral 2810.5', slug: 'wage-notice-2810-5-es', fields: 18, owners: { worker: 5, hamilton: 13 } },
  { title: 'New Hire Policy Acknowledgment', slug: 'policy-acknowledgment', fields: 33, owners: { worker: 30, hamilton: 3 } },
  { title: 'Acuse de Recibo de Políticas', slug: 'policy-acknowledgment-es', fields: 33, owners: { worker: 30, hamilton: 3 } },
  { title: 'Safety Training Roster', slug: 'safety-training-roster', fields: 65, owners: { worker: 54, hamilton: 11 } },
  { title: 'Registro de Capacitación en Seguridad', slug: 'safety-training-roster-es', fields: 65, owners: { worker: 54, hamilton: 11 } },
  { title: 'Injury and Illness Prevention Program (IIPP)', slug: 'iipp', fields: 5, owners: { hamilton: 5 } },
  { title: 'Heat Illness Prevention Plan', slug: 'heat-illness-prevention-plan', fields: 4, owners: { hamilton: 4 } },
  { title: 'Plan de Prevención de Enfermedades por Calor', slug: 'heat-illness-prevention-plan-es', fields: 4, owners: { hamilton: 4 } },
  { title: 'Fall Protection Program', slug: 'fall-protection-program', fields: 3, owners: { hamilton: 3 } },
  { title: 'Code of Safe Practices', slug: 'code-of-safe-practices', fields: 2, owners: { hamilton: 2 } },
];

export const TEMPLATE_BY_TITLE = new Map(TEMPLATE_REGISTRY.map((entry) => [entry.title, entry]));
export const TEMPLATE_BY_SLUG = new Map(TEMPLATE_REGISTRY.map((entry) => [entry.slug, entry]));
export const DEFAULT_DOCUMENT_SLUGS = TEMPLATE_REGISTRY.map((entry) => entry.slug);

export function requireUniqueActiveTemplate(templates, title) {
  const matches = templates.filter((template) => template.name === title && !template.archived_at);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one active template named "${title}", found ${matches.length}`);
  }
  return matches[0];
}
