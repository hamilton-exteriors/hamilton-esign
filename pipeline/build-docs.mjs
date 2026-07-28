// Hamilton doc pipeline: markdown -> print HTML (field-marked) -> PDF + field coords
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { marked } from 'marked';

const SRC = 'C:/Users/admin/.claude/skills/onboard-worker/references/documents';
const OUT = 'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/build';
mkdirSync(OUT, { recursive: true });

// LETTER geometry, and the trade-off behind it is worth stating.
//
// DocuSeal rasterises each page and scales it to the container width, so on a
// 390px phone a Letter page renders at about 0.46 scale and 10.5pt body type
// arrives near 6.4 CSS px. That is why this was built at phone size for a while.
//
// It was the wrong call. The signer reads and fills through the step prompts at
// the bottom of the screen, which quote each field and scroll to it, and the
// document itself can be pinched. Meanwhile the PDF is permanent: it is the copy
// the worker is owed under Labor Code 432, the file in Drive, and the exhibit a
// Labor Commissioner would read. Optimising the artifact for one phone session
// produced a 4.38in x 7.79in sheet with oversized type and a two page agreement
// filed as twelve.
//
// So: proper document, and legibility on the phone comes from the prompts.
// US Letter at 96dpi, with the margins from the contractor document standard:
// top 1.25in (letterhead zone), bottom 1in (footer), left 1.5in (binding),
// right 1.25in. Content width lands at 5.75in, which is the 65-75 characters
// per line where reading is easiest at 10.5pt.
//
// This was 420x748 for a long time, chosen so the document would be legible on
// a phone during signing. It made the artifact wrong: the executed PDF came out
// 4.38in x 7.79in, so 15px body type was proportionally enormous and a two page
// agreement filed as twelve. That PDF is not just a signing surface, it is the
// record that goes to the worker under Labor Code 432, into Drive, and in front
// of a Labor Commissioner. It has to be a document first.
export const PAGE = { w: 816, h: 1056, mt: 120, mb: 96, ml: 144, mr: 120 };

// @page MUST agree with PAGE. It said `size: Letter` while the pages were 420px
// wide, so Chromium laid the document out for an 816px sheet and page.pdf() then
// scaled the result down to fit 420px. The PDF ended up with the whole document
// shrunk into the top-left ~38% x 45% of each page, while the coordinates were
// measured against the unscaled DOM, so every field area sat high and left of
// the rule it belonged to. The comment at the top of measure.mjs describes this
// exact failure as already fixed; it was fixed in one of the two places.
//
// measure.mjs passes preferCSSPageSize, so this rule is what decides the paper.
const CSS = `
@page { size: ${PAGE.w * 0.75}pt ${PAGE.h * 0.75}pt; margin: 0; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
/* Type scale from the contractor document standard, converted pt -> px at 96dpi
   (1pt = 4/3 px): body 10.5pt, title 24, H1 18, H2 14, H3 11, fine print 9,
   caption 8. One family, hierarchy from weight and size. Vertical rhythm is the
   6pt grid, so every margin below is a multiple of 8px. */
body{
  font-family:"Helvetica Neue",Helvetica,Calibri,Arial,sans-serif;
  font-size:14px; line-height:20px; color:#1a1a1a;
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
/* Document title, 24pt bold with the wide tracking the standard calls for. */
h1{font-size:32px;line-height:38px;font-weight:700;letter-spacing:.02em;margin:0 0 8px}
/* Section, 18pt. The rule under it separates sections without a heavy band. */
h2{font-size:24px;line-height:28px;font-weight:700;margin:32px 0 12px;
   padding-bottom:6px;border-bottom:1px solid #c9c9c9}
/* Subsection, 14pt semibold. */
h3{font-size:18.5px;line-height:23px;font-weight:600;margin:24px 0 8px}
h4{font-size:14.5px;line-height:19px;font-weight:700;margin:16px 0 6px}
p{margin:0 0 12px}
ul,ol{margin:0 0 12px;padding-left:24px}
li{margin:0 0 6px}
strong{font-weight:700}
hr{border:0;border-top:1px solid #c9c9c9;margin:24px 0}
/* Tables hold short labels and numbers. Slightly tighter leading for density. */
table{width:100%;border-collapse:collapse;margin:12px 0 20px;font-size:13px;line-height:18px}
th{text-align:left;font-weight:600;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
   color:#555;border-bottom:1px solid #333;padding:8px 6px}
td{padding:8px 6px;border-bottom:1px solid #e2e2e2;vertical-align:top}
/* Fine print, 9pt. Never smaller: below 8pt reads as hiding something. */
.legal{font-size:12px;line-height:16px;color:#4a4a4a}
/* Caption, 8pt medium all caps with wide tracking. */
.doc-meta{font-size:10.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;
          color:#5a5a5a;margin:0 0 16px}

/* ---- letterhead (zone 1) --------------------------------------------------
   Sits in the 1.25in top margin zone of page 1. Every prior build produced a
   document with no mark on it at all, which for a signed employment record is
   the first thing a reader looks for. */
.letterhead{display:flex;align-items:flex-start;justify-content:space-between;
            gap:24px;margin:0 0 24px;padding-bottom:16px;border-bottom:2px solid #1B3C2D}
.letterhead img{height:46px;width:auto;display:block}
.letterhead .lh-meta{text-align:right;font-size:10.5px;line-height:15px;color:#5a5a5a;
                     letter-spacing:.06em;text-transform:uppercase}
.letterhead .lh-meta strong{display:block;font-size:11px;color:#1B3C2D;letter-spacing:.1em}

/* ---- running footer -------------------------------------------------------
   Absolutely placed inside the bottom margin, so it never affects the flow the
   pagination measures. measure.mjs stamps data-n / data-total. */
.page::after{
  content:attr(data-foot);
  position:absolute; left:${PAGE.ml}px; right:${PAGE.mr}px; bottom:${Math.round(PAGE.mb / 2.5)}px;
  font-size:10px; line-height:14px; color:#7a7a7a; letter-spacing:.04em;
  border-top:1px solid #e2e2e2; padding-top:8px;
  display:flex; justify-content:space-between; white-space:pre;
}

/* Field markers: invisible in print, measured in the browser. Sized as form
   fields on a Letter sheet (about 0.22in tall) rather than as phone tap
   targets, which is what made them tower over their own text line. */
.ds{display:inline-block;min-width:180px;height:21px;vertical-align:bottom;
    border-bottom:1px solid #444}
.ds-sig{min-width:250px;height:34px}
/* A checkbox occupies the glyph's own footprint, so it must NOT inherit the
   prose min-width or it pushes the label off the line. */
.ds-box{min-width:13px;width:13px;height:13px;border:1px solid #444;
        border-bottom-width:1px;vertical-align:baseline;margin-right:5px}
.ds-ini{min-width:70px;height:21px}
.ds-date{min-width:130px;height:21px}
/* A prose min-width is far too wide for a table cell: the 4-column task table
   put an initials box past the right edge, where DocuSeal clips or mis-places
   it. Table cells get their own floor. */
td .ds, th .ds{min-width:44px;max-width:100%}
td .ds-ini{min-width:44px}
td .ds-date{min-width:78px}
td .ds-sig{min-width:90px}
`;

// ---- field extraction -------------------------------------------------------
let fieldSeq = 0;
const RE_BLANK = /_{4,}/g;

// A "☐" is a real election, not decoration. Left as a static glyph these never
// become fields, so the signed PDF ships with BOTH pay-rate boxes unmarked on a
// §2810.5 notice whose entire legal purpose is to state the rate of pay. Every
// remaining ☐ in the documents is employer-elected (which rate applies, which
// sick-leave method, which language was provided), so they become checkbox
// fields owned by Hamilton and prefilled per hire at submission time.
// Fact statements that merely READ like elections were rewritten as statements
// instead ("Meals: none claimed") — a box beside an answer implies a question.
const RE_CHECKBOX = /☐/g;

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
    // Checkbox pass. Unlike a blank, the label FOLLOWS the glyph ("☐ Roofer"),
    // so take the text after it, up to a bold marker or end of cell.
    const withBoxes = replaced.replace(RE_CHECKBOX, (glyph, off) => {
      const after = replaced.slice(off + glyph.length);
      // Stop at the NEXT glyph, or "☐ Roofer ☐ Foreman" makes the first label
      // swallow the second option. Also decode entities marked() emitted, or
      // the prompt reads "The Employee&#39;s primary language".
      let label = (after.match(/^\s*([^|*\n☐☒]{2,44})/) || [])[1] || '';
      label = label
        .replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ').trim().replace(/[:\-—,]+$/, '');
      // Long election sentences get a SHORT STABLE name instead of a truncated
      // one. Truncation broke prefill matching: "…primary language is Spani"
      // no longer contains "spanish", and the Spanish line was cut before
      // "español" entirely, so both language boxes ticked at once. A stable key
      // is also a better prompt than a sentence fragment.
      // Classify from the untruncated text of THIS option only. Two traps here:
      // the 44-char label capture cuts "…is Spanish" to "…is Spani" (so the
      // Spanish option classified as English), and a wider window runs past the
      // newline into the NEXT option (so both classified as Spanish). Stop at
      // the line break, and at the next glyph, and trim.
      const norm = after.split(/[\n☐☒|]/)[0].trim().toLowerCase();
      if (/primary language|idioma principal/.test(norm)) {
        label = /spanish|español|espanol/.test(norm) ? 'Language: Spanish' : 'Language: English';
      } else if (/^accrual|^acumulaci/.test(norm)) {
        label = 'Sick leave: accrual';
      } else if (/^front load|^entrega adelantada/.test(norm)) {
        label = 'Sick leave: front load';
      } else if (label.length > 40) {
        const cut = label.slice(0, 40); const sp = cut.lastIndexOf(' ');
        label = (sp > 24 ? cut.slice(0, sp) : cut) + '…';
      }
      fieldSeq += 1;
      if (!label || label.length < 2) label = `Choice ${fieldSeq}`;
      const id = `f${fieldSeq}`;
      // Employer-owned: which rate applies, which sick-leave method and which
      // language was provided are all Hamilton's statements, not the worker's.
      fields.push({ id, name: label, type: 'checkbox', owner: 'employer', section });
      return `<span class="ds ds-box" id="${id}" data-name="${label.replace(/"/g, '')}" ` +
             `data-type="checkbox" data-owner="employer" data-section="${section.replace(/"/g, '')}"></span>`;
    });
    return `>${withBoxes}`;
  });
  return { html: out, fields };
}

/** Letterhead for page 1. The mark is inlined so the PDF carries no external
 *  reference: a signed record that depends on a live URL to render its own logo
 *  is a record that degrades. Same wordmark the signer page uses. */
const LOGO = (() => {
  const erb = readFileSync('C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/hamilton-esign/brand/_logo.html.erb', 'utf8');
  const m = erb.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/);
  return m ? m[0] : null;
})();

function letterhead() {
  const mark = LOGO
    ? `<img src="${LOGO}" alt="Hamilton Exteriors">`
    : '<strong style="font-size:20px;color:#1B3C2D">Hamilton Exteriors</strong>';
  return `<div class="letterhead">${mark}<div class="lh-meta">` +
    '<strong>ABR Quality Resources Inc</strong>dba Hamilton Exteriors<br>' +
    '21634 Redwood Rd Unit F, Castro Valley, CA 94546<br>' +
    'CSLB 1078806' +
    '</div></div>';
}

/** Split flowed content into fixed-size .page divs is done in-browser; here we wrap once. */
function wrap(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style></head><body><div class="flow">${letterhead()}${bodyHtml}</div></body></html>`;
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
