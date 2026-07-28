// The two kinds of person Hamilton onboards, and a hard gate between them.
//
// This file exists because sending the wrong packet is the most damaging
// mistake available in this whole system, in BOTH directions:
//
//   - A California employment packet sent to an overseas contractor asserts a
//     §2810.5 wage notice, Cal/OSHA training and workers comp coverage for
//     someone none of that law reaches. It is a signed record of compliance
//     with rules that do not apply, and it implies an employment relationship
//     nobody intended.
//
//   - An independent contractor agreement sent to a local roofer is the
//     misclassification trap. It asserts non-employee status for a W-2 employee
//     doing the employer's core trade under the employer's direction, with the
//     employer's tools. That is the single most damaging document a plaintiff,
//     the EDD or a DLSE hearing officer could find, and it is worse than
//     sending nothing at all.
//
// So `type` is required with no default, and every document list is keyed to it.
// There is no "close enough" path: an unknown type throws.

export const WORKER_TYPES = {
  /** W-2 employee working in California. Roofers, foremen, local staff. */
  w2_local: {
    label: 'W-2 employee (California)',
    employment: 'employee',
    jurisdiction: 'California',
    // Documents Hamilton authors, in signing order. Titles must match the live
    // DocuSeal template names exactly — resolve by name, never by id, because
    // ids change on every pipeline rebuild.
    packet: {
      en: [
        { key: 'agreement',      title: 'Employment Agreement' },
        { key: 'wage-notice',    title: 'Wage Notice - Labor Code 2810.5' },
        { key: 'acknowledgment', title: 'New Hire Policy Acknowledgment' },
        { key: 'safety-roster',  title: 'Safety Training Roster' },
      ],
      es: [
        { key: 'agreement',      title: 'Contrato de Empleo' },
        { key: 'wage-notice',    title: 'Aviso de Salario - Código Laboral 2810.5' },
        { key: 'acknowledgment', title: 'Acuse de Recibo de Políticas' },
        { key: 'safety-roster',  title: 'Registro de Capacitación en Seguridad' },
      ],
    },
    // Sent over WhatsApp before the acknowledgment, which has the worker
    // initial that he received them.
    pamphlets: true,
    // Government forms Hamilton must collect but does NOT author. Never retype
    // these; download the current version from the agency.
    govForms: ['Form I-9', 'Form W-4', 'CA DE 4'],
    // Three physically separate files per employee is a legal requirement.
    filing: ['Personnel', 'I-9', 'Medical'],
    blockers: [
      'Workers comp policy must carry roofing class 5552 before anyone is on a roof',
      'Wage notice section 6 (carrier, policy number, address, phone) must be filled',
    ],
  },

  /** Non-US independent contractor, e.g. a Philippines production coordinator
   *  hired through OnlineJobs.ph. Not an employee. No US or California
   *  employment law applies to the engagement. */
  overseas_contractor: {
    label: 'Overseas independent contractor (non-US)',
    employment: 'contractor',
    jurisdiction: 'non-US',
    // Authored 2026-07-28 from the agreement Pat (Fatmih Makburi) actually
    // signed on 2026-07-21, generalised so the commercial terms are per-hire
    // fields instead of hardcoded. Nicole Nascimento's 2026-07-10 set is the
    // second precedent and matches.
    //
    // Still deliberately NOT pointed at any W-2 document. There is no Spanish
    // variant on purpose: the two contractors to date work in English, and an
    // unreviewed machine translation of a contract is worse than no translation.
    packet: {
      en: [
        { key: 'contractor-agreement', title: 'Independent Contractor Agreement' },
      ],
    },
    // No California pamphlets: DE 2320/2515/2511, the DWC pamphlet, the CRD
    // sheet and the domestic-violence notice are California EMPLOYEE
    // entitlements and are meaningless to a contractor abroad.
    pamphlets: false,
    // W-8BEN, not W-9 and not W-4. A foreign individual certifies non-US status
    // so Hamilton does not withhold and does not issue a 1099. Sending a W-9 or
    // a 1099 to a non-US person is the classic error here.
    govForms: ['IRS Form W-8BEN'],
    filing: ['Contractors'],
    // Explicitly NOT applicable, recorded so nobody re-adds them by analogy.
    notApplicable: [
      'Labor Code 2810.5 wage notice',
      'Cal/OSHA IIPP / heat illness / fall protection training',
      'Workers compensation',
      'Form I-9 (no US work authorisation involved)',
      'DE 34 new hire report, DE 4 withholding',
      'The California pamphlet set',
    ],
    // Handouts delivered over WhatsApp alongside the agreement. Neither is
    // signable here: the W-8BEN is an IRS form the contractor downloads, signs
    // and emails back, and the role expectations document is reference material.
    handouts: [
      { key: 'w8ben', title: 'W-8BEN instructions',
        note: 'IRS form, contractor downloads from irs.gov, signs, emails back to admin@' },
      { key: 'role-expectations', title: 'Role expectations',
        note: 'Per-role. Pat/Nicole used "Roofing Project Coordinator - Role Expectations".' },
    ],
    blockers: [
      'No payment until the signed W-8BEN is on file (agreement section 3.3)',
      'Role expectations document is per-role and must exist before sending',
    ],
  },
};

/** Everything still needing an owner decision. Surfaced rather than guessed at.
 *
 *  Most of this list was answered all along and nobody had checked: the
 *  agreement Pat signed on 2026-07-21 settles governing law (California, sec 8),
 *  scope (sec 1, via a per-role expectations document), rate and cadence (sec 3,
 *  two installments by Mercury), IP and confidentiality (sec 5 and 6), and term
 *  and notice (sec 4, seven days either way). Those are now the template, not
 *  open questions. Check Drive before declaring something undrafted. */
export const NEEDS_OWNER_DECISION = {
  // Empty, and that is the finished state, not an unfilled stub. Owner ruled
  // 2026-07-28: no equipment or software stipend (now section 7, stated
  // explicitly rather than left silent), and venue is Alameda County, which is
  // where Castro Valley sits, so it pairs with the California governing law the
  // agreement already had (now section 9).
  overseas_contractor: [],
};

/** Resolve a type, or refuse. No default — a guess here is the failure mode. */
export function resolveType(type) {
  if (!type) {
    throw new Error(
      'worker type is required, no default. Use "w2_local" for a California ' +
      'employee or "overseas_contractor" for a non-US contractor. Guessing wrong ' +
      'sends either a misclassification document to an employee or a California ' +
      'compliance packet to someone that law does not reach.');
  }
  const t = WORKER_TYPES[type];
  if (!t) throw new Error(`unknown worker type "${type}". Known: ${Object.keys(WORKER_TYPES).join(', ')}`);
  return t;
}

/** The document list for a type + language, or an explanation of why there
 *  isn't one. Never falls back to another type's documents. */
export function packetFor(type, language = 'en') {
  const t = resolveType(type);
  const lang = t.packet[language] ? language : 'en';
  const docs = t.packet[lang] || [];
  if (!docs.length) {
    const needs = NEEDS_OWNER_DECISION[type] || [];
    throw new Error(
      `no ${type} packet exists yet, and it will not fall back to another worker ` +
      `type's documents. Outstanding: ${t.blockers.join('; ')}.` +
      (needs.length ? ` Owner decisions needed: ${needs.join('; ')}.` : ''));
  }
  return { docs, lang, type: t };
}

/** Sanity check a worker record against its declared type before anything is
 *  sent. Catches the obvious mismatches with a readable reason. */
export function validate(worker) {
  const t = resolveType(worker.type);
  const problems = [];
  if (!worker.name) problems.push('name is required');
  if (!worker.phone) problems.push('phone is required (WhatsApp delivery)');

  const digits = String(worker.phone || '').replace(/[\s()-]/g, '');
  const intl = digits && !/^\+1/.test(digits);
  if (worker.type === 'w2_local' && intl) {
    problems.push(
      `phone ${worker.phone} is not a +1 number but the type is w2_local. ` +
      'Confirm the type before sending anything.');
  }
  if (worker.type === 'overseas_contractor' && digits && !intl) {
    problems.push(
      `phone ${worker.phone} looks domestic (+1) but the type is ` +
      'overseas_contractor. If this person works in California they are almost ' +
      'certainly an employee, not a contractor.');
  }
  return { ok: problems.length === 0, problems, type: t };
}
