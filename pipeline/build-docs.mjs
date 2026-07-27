// Hamilton doc pipeline: markdown -> print HTML (field-marked) -> PDF + field coords
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { marked } from 'marked';

const SRC = 'C:/Users/admin/.claude/skills/onboard-worker/references/documents';
const OUT = 'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/build';
mkdirSync(OUT, { recursive: true });

// PHONE geometry, deliberately not Letter.
//
// DocuSeal rasterises each page and scales the image to the container width. On
// a 390px phone the container is ~374px, so a Letter page built at 816px lands
// at 374/816 = 0.458 scale: 10.5pt body text renders at about 6.4 CSS px and a
// 20px initials box becomes 9px tall. The worker cannot read the document he is
// signing and cannot reliably hit the fields, which made every other
// improvement chrome around an illegible page.
//
// At 420px wide the same container renders ~0.89:1, so 15px body text arrives at
// ~13px and a 44px field stays ~39px. measure.mjs normalises all coordinates to
// 0-1, so the field mapping follows automatically, and it already asserts zero
// page overflow, which makes the repagination self-checking.
//
// Keep a Letter build for anything printed or filed: PAGE_PRINT below.
export const PAGE = { w: 420, h: 748, mt: 40, mb: 34, ml: 30, mr: 30 };
export const PAGE_PRINT = { w: 816, h: 1056, mt: 120, mb: 96, ml: 144, mr: 120 };

const CSS = `
@page { size: Letter; margin: 0; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
/* Sizes are px, not pt: this page is read on a phone at ~0.89:1, so the number
   here is close to what the eye gets. Anything under 15px body lands illegible. */
body{
  font-family:"Helvetica Neue",Helvetica,Calibri,Arial,sans-serif;
  font-size:15px; line-height:21px; color:#1a1a1a;
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
h1{font-size:21px;line-height:26px;font-weight:700;letter-spacing:.2px;margin:0 0 8px}
h2{font-size:17px;line-height:22px;font-weight:600;margin:22px 0 8px;
   padding-bottom:4px;border-bottom:1px solid #d8d8d8}
h3{font-size:15px;line-height:20px;font-weight:700;margin:16px 0 5px}
p{margin:0 0 11px}
ul,ol{margin:0 0 11px;padding-left:20px}
li{margin:0 0 5px}
strong{font-weight:700}
hr{border:0;border-top:1px solid #d8d8d8;margin:16px 0}
table{width:100%;border-collapse:collapse;margin:8px 0 16px;font-size:14px;line-height:19px}
th{text-align:left;font-weight:600;font-size:12px;letter-spacing:.4px;text-transform:uppercase;
   color:#555;border-bottom:1px solid #333;padding:6px 5px}
td{padding:7px 5px;border-bottom:1px solid #e2e2e2;vertical-align:top}
/* Was 8pt -> ~4.9 CSS px on a phone, i.e. unreadable. Fine print is still
   print a worker is signing. */
.legal{font-size:13px;line-height:18px;color:#4a4a4a}
.doc-meta{font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:#5a5a5a;margin:0 0 14px}
/* Field markers: invisible in print, measured in the browser. Heights are the
   tap target — 20px here became 9px on a phone. 44px stays ~39px at 0.89:1. */
.ds{display:inline-block;min-width:150px;height:44px;vertical-align:bottom;
    border-bottom:1px solid #444}
.ds-sig{min-width:230px;height:56px}
.ds-ini{min-width:64px;height:44px}
.ds-date{min-width:130px;height:44px}
/* 150px is right for a blank in prose and far too wide for a table cell — the
   4-column task table put an initials box 5% past the right edge of the page,
   where DocuSeal would clip or mis-place it. Table cells get their own floor. */
td .ds, th .ds{min-width:40px;max-width:100%}
td .ds-ini{min-width:40px}
td .ds-date{min-width:70px}
td .ds-sig{min-width:90px}
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
  // Anchor the capture at a word start, not mid-token: the old {2,48} window
  // could begin inside a word and produce a prompt reading "apacitación se dio
  // en". clip() only trimmed the END of a label; this trims the front.
  const colon = s.match(/(?:^|[\s>])([A-Za-z¿ÁÉÍÓÚÜÑáéíóúüñ0-9'()\/. -]{2,48}?)\s*:\s*$/);
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

/** Short section label from an h2, for the signer's prompt.
 *  "## Part 2 — Fall protection (§1670 — written certification required)"
 *  becomes "Part 2 · Fall protection". The drawer prompt is the only text a
 *  signer reads at each step, so it has to carry where they are; a 65-field
 *  roster with no section context is an undifferentiated grind. */
function sectionLabel(heading) {
  let s = heading.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, '');                 // drop trailing (§…) note
  const m = s.match(/^(Part|Parte)\s+(\d+)\s*[—–-]\s*(.+)$/i);
  if (m) {
    const topic = m[3].split(/\s*[—–(]/)[0].trim();
    return `${m[1]} ${m[2]} · ${topic}`;
  }
  const lettered = s.match(/^([A-K])\.\s+(.+)$/);
  if (lettered) return `${lettered[1]} · ${lettered[2]}`;
  return s.length <= 34 ? s : '';
}

/** Replace ____ runs in rendered HTML with measurable spans. */
function markFields(html, defaultOwner = 'worker') {
  const fields = [];
  let owner = defaultOwner;
  let section = '';
  // The entity name also appears as the LETTERHEAD at the top of every document.
  // Only treat it as the countersignature marker once we are actually in the
  // signature area, i.e. after at least one signature field has been emitted.
  let seenSignature = false;
  // Match h2 blocks AND bare text nodes in document order, so the current
  // section is known by the time a blank inside it is processed. A text-node-
  // only pass cannot see which heading it sits under.
  // The closing `<` is a LOOKAHEAD, not consumed: `>([^<]+)<` would swallow the
  // `<` that opens the next tag, so every `<h2` got eaten by the preceding text
  // node and no field ever learned its section.
  const out = html.replace(/(<h2[^>]*>[\s\S]*?<\/h2>)|>([^<]+)(?=<)/g, (whole, h2, text) => {
    if (h2) {
      section = sectionLabel(h2.replace(/<[^>]+>/g, ''));
      return whole;
    }
    const t = text.trim();
    // Company safety programs are Hamilton's own record end to end; an
    // "Employee" heading inside one must not hand fields to a worker.
    if (defaultOwner !== 'employer') {
      if (RE_WORKER_HEAD.test(t)) owner = 'worker';
      else if (seenSignature && RE_EMPLOYER_HEAD.test(t) && t.length < 80) owner = 'employer';
    }
    // The signature block is not part of the last content section. Without this
    // the sticky section label filed the worker's whole-document signature
    // under whatever heading happened to come last ("K · Idioma").
    if (RE_WORKER_HEAD.test(t) || RE_EMPLOYER_HEAD.test(t)) section = '';
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
      fields.push({ id, name: label, type, owner: fieldOwner, section });
      const cls = type === 'signature' ? 'ds ds-sig'
        : type === 'initials' ? 'ds ds-ini'
        : type === 'date' ? 'ds ds-date' : 'ds';
      return `<span class="${cls}" id="${id}" data-name="${label.replace(/"/g, '')}" data-type="${type}" data-owner="${fieldOwner}" data-section="${section.replace(/"/g, '')}"></span>`;
    });
    return `>${replaced}`;
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

// measure.mjs imports PAGE from this file. Without an entry-point guard that
// import would re-run the whole document build as a side effect.
const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

const DOCS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'employment-agreement', 'employment-agreement-es',
  'wage-notice-2810-5', 'wage-notice-2810-5-es',
  'policy-acknowledgment', 'policy-acknowledgment-es',
  'safety-training-roster', 'safety-training-roster-es',
  'iipp', 'heat-illness-prevention-plan', 'heat-illness-prevention-plan-es',
  'fall-protection-program', 'code-of-safe-practices',
];

if (IS_MAIN) {
const manifest = DOCS.map(buildOne);
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
for (const m of manifest) {
  const byType = m.fields.reduce((a, f) => (a[f.type] = (a[f.type] || 0) + 1, a), {});
  console.log(`${m.slug.padEnd(34)} fields=${String(m.fields.length).padStart(3)}  ${JSON.stringify(byType)}`);
}
}
