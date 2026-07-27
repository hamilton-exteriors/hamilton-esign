// Hamilton doc pipeline: markdown -> print HTML (field-marked) -> PDF + field coords
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { marked } from 'marked';

const SRC = 'C:/Users/admin/.claude/skills/onboard-worker/references/documents';
const OUT = 'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/build';
mkdirSync(OUT, { recursive: true });

// Letter @96dpi. Margins per contractor-doc-design: T1.25 B1.0 L1.5 R1.25
export const PAGE = { w: 816, h: 1056, mt: 120, mb: 96, ml: 144, mr: 120 };

const CSS = `
@page { size: Letter; margin: 0; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:"Helvetica Neue",Helvetica,Calibri,Arial,sans-serif;
  font-size:10.5pt; line-height:14.5pt; color:#1a1a1a;
  -webkit-font-smoothing:antialiased;
}
/* EXACT height, not min-height: a page div that grows even 1px spills into a
   second PDF page and every field after it lands on the wrong page. */
.page{
  width:${PAGE.w}px; height:${PAGE.h}px; position:relative;
  padding:${PAGE.mt}px ${PAGE.mr}px ${PAGE.mb}px ${PAGE.ml}px;
  page-break-after:always; break-after:page; overflow:hidden;
}
.page:last-child{page-break-after:auto;break-after:auto}
.page>*:first-child{margin-top:0}
.page>*:last-child{margin-bottom:0}
h1{font-size:19pt;line-height:23pt;font-weight:700;letter-spacing:.2px;margin:0 0 6pt}
h2{font-size:13pt;line-height:17pt;font-weight:600;margin:18pt 0 6pt;
   padding-bottom:3pt;border-bottom:.75pt solid #d8d8d8}
h3{font-size:11pt;line-height:15pt;font-weight:700;margin:12pt 0 4pt}
p{margin:0 0 8pt}
ul,ol{margin:0 0 8pt;padding-left:16pt}
li{margin:0 0 3pt}
strong{font-weight:700}
hr{border:0;border-top:.75pt solid #d8d8d8;margin:12pt 0}
table{width:100%;border-collapse:collapse;margin:6pt 0 12pt;font-size:9.5pt;line-height:13pt}
th{text-align:left;font-weight:600;font-size:8pt;letter-spacing:.6px;text-transform:uppercase;
   color:#555;border-bottom:1pt solid #333;padding:5pt 6pt}
td{padding:5pt 6pt;border-bottom:.5pt solid #e2e2e2;vertical-align:top}
.legal{font-size:8pt;line-height:11pt;color:#555}
.doc-meta{font-size:8pt;letter-spacing:.6px;text-transform:uppercase;color:#666;margin:0 0 12pt}
/* Field markers: invisible in print, measured in the browser */
.ds{display:inline-block;min-width:150px;height:20px;vertical-align:bottom;
    border-bottom:.75pt solid #444}
.ds-sig{min-width:230px;height:34px}
.ds-ini{min-width:52px;height:20px}
.ds-date{min-width:110px;height:20px}
td .ds-ini{min-width:46px}
`;

// ---- field extraction -------------------------------------------------------
let fieldSeq = 0;
const RE_BLANK = /_{4,}/g;

function classify(label, seg) {
  const c = (label + ' ' + seg).toLowerCase();
  if (/signature|sign here|\bfirma\b/.test(c)) return 'signature';
  if (/initial|iniciales/.test(c)) return 'initials';
  if (/\bdate\b|\bfecha\b/.test(c)) return 'date';
  return 'text';
}

/** Label = the text immediately preceding THIS blank, since the previous blank. */
function labelFrom(seg) {
  const s = seg.replace(/\s+/g, ' ').trim();
  // "Something:" right before the blank is the strongest signal
  const colon = s.match(/([A-Za-z¿ÁÉÍÓÚÜÑáéíóúüñ0-9'()\/. -]{2,48}?)\s*:\s*$/);
  if (colon) {
    // The capture can reach back across a sentence boundary and drag the tail
    // of the preceding sentence in ("...Inc. Section B initials"). The label is
    // whatever follows the last full stop.
    const parts = colon[1].trim().split(/(?<=[.!?])\s+/);
    return parts[parts.length - 1].trim().replace(/^[-–—•\d.]+\s*/, '');
  }
  // otherwise the trailing few words
  const tail = s.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9'()\/. -]+$/, '').split(' ').slice(-5).join(' ').trim();
  return tail.replace(/^[-–—•\d.]+\s*/, '');
}

// Which party owns the blanks that follow. Documents mark this with a bold
// heading: "**Employee**" opens the worker's block, the legal entity name opens
// Hamilton's countersignature block. Without this the worker gets asked to sign
// on the company's behalf and to fill in the WC carrier.
// Must be the WHOLE text node (a standalone heading), not merely contain the
// name — body copy like "signed by the President of ABR Quality Resources Inc."
// is prose, not a countersignature marker.
const RE_EMPLOYER_HEAD = /^ABR Quality Resources\b/i;
const RE_WORKER_HEAD = /^\s*(Employee|Empleado|Trabajador|Worker)\s*$/i;

/** Replace ____ runs in rendered HTML with measurable spans. */
function markFields(html, defaultOwner = 'worker') {
  const fields = [];
  let owner = defaultOwner;
  // The entity name also appears as the LETTERHEAD at the top of every document.
  // Only treat it as the countersignature marker once we are actually in the
  // signature area, i.e. after at least one signature field has been emitted.
  let seenSignature = false;
  // operate only on text outside tags
  const out = html.replace(/>([^<]+)</g, (whole, text) => {
    const t = text.trim();
    // Company safety programs are Hamilton's own record end to end; an
    // "Employee" heading inside one must not hand fields to a worker.
    if (defaultOwner !== 'employer') {
      if (RE_WORKER_HEAD.test(t)) owner = 'worker';
      else if (seenSignature && RE_EMPLOYER_HEAD.test(t) && t.length < 80) owner = 'employer';
    }
    let cursor = 0;
    const replaced = text.replace(RE_BLANK, (blank, off) => {
      const seg = text.slice(cursor, off);   // text since the previous blank
      cursor = off + blank.length;
      let label = labelFrom(seg);
      const type = classify(label, seg);
      // Employer-fill regardless of position — but only for label-shaped text.
      // A sentence ending in a period is body copy ("...before the pay period
      // closes."), not a field label, and its blank belongs to the signer.
      const labelShaped = label.length < 32 && !/[.!?]$/.test(label);
      const isEmployerField = labelShaped &&
        /carrier|policy (no|number)|payday|pay period|workers comp/i.test(label);
      const fieldOwner = isEmployerField ? 'employer' : owner;
      fieldSeq += 1;
      if (type === 'signature') seenSignature = true;
      if (!label || label.length < 2) label = `Field ${fieldSeq}`;
      const id = `f${fieldSeq}`;
      fields.push({ id, name: label, type, owner: fieldOwner });
      const cls = type === 'signature' ? 'ds ds-sig'
        : type === 'initials' ? 'ds ds-ini'
        : type === 'date' ? 'ds ds-date' : 'ds';
      return `<span class="${cls}" id="${id}" data-name="${label.replace(/"/g, '')}" data-type="${type}" data-owner="${fieldOwner}"></span>`;
    });
    return `>${replaced}<`;
  });
  return { html: out, fields };
}

/** Split flowed content into fixed-size .page divs is done in-browser; here we wrap once. */
function wrap(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style></head><body><div class="flow">${bodyHtml}</div></body></html>`;
}

// Company safety programs are signed once by Hamilton, not by a worker.
const COMPANY_DOCS = new Set(['iipp', 'heat-illness-prevention-plan',
  'heat-illness-prevention-plan-es', 'fall-protection-program', 'code-of-safe-practices']);

export function buildOne(slug) {
  fieldSeq = 0;
  const md = readFileSync(`${SRC}/${slug}.md`, 'utf8');
  const rawHtml = marked.parse(md, { mangle: false, headerIds: false });
  const { html, fields } = markFields(rawHtml, COMPANY_DOCS.has(slug) ? 'employer' : 'worker');
  const doc = wrap(slug, html);
  writeFileSync(`${OUT}/${slug}.html`, doc);
  return { slug, fields };
}

const DOCS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'employment-agreement', 'employment-agreement-es',
  'wage-notice-2810-5', 'wage-notice-2810-5-es',
  'policy-acknowledgment', 'policy-acknowledgment-es',
  'safety-training-roster', 'safety-training-roster-es',
  'iipp', 'heat-illness-prevention-plan', 'heat-illness-prevention-plan-es',
  'fall-protection-program', 'code-of-safe-practices',
];

const manifest = DOCS.map(buildOne);
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
for (const m of manifest) {
  const byType = m.fields.reduce((a, f) => (a[f.type] = (a[f.type] || 0) + 1, a), {});
  console.log(`${m.slug.padEnd(34)} fields=${String(m.fields.length).padStart(3)}  ${JSON.stringify(byType)}`);
}
