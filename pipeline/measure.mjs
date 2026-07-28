// Load each field-marked HTML, paginate it, refine field types from DOM context,
// measure exact boxes, then emit PDF + DocuSeal-normalised field coordinates.
import { readFileSync, writeFileSync } from 'node:fs';
import pw from 'file:///C:/Users/admin/AppData/Roaming/npm/node_modules/playwright/index.js';
const { chromium } = pw;

const DIR = 'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/build';
// IMPORTED, never redeclared. This file previously carried its own copy of the
// Letter geometry, so changing PAGE in build-docs.mjs silently did nothing: the
// HTML was laid out at phone size while the viewport, the coordinate
// normalisation denominator and page.pdf() all still used 816x1056. The result
// was phone-sized content crammed into the top-left ~45% x 65% of a Letter
// canvas, and every "we fixed legibility" claim was false at the last mile.
// Two constants for one fact is the bug; there is now one.
import { PAGE } from './build-docs.mjs';
const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, 'utf8'));

// Injected: flow content into fixed pages, refine types, measure.
const SCRIPT = ({ w, h, mt, mb, ml, mr }) => {
  const flow = document.querySelector('.flow');
  const contentH = h - mt - mb;
  // Build pages by moving block children until each page is full.
  const blocks = Array.from(flow.children);
  const pages = [];
  let page = null, used = 0;
  const newPage = () => {
    page = document.createElement('div');
    page.className = 'page';
    document.body.appendChild(page);
    pages.push(page); used = 0;
  };
  newPage();
  // Overflow-driven: ask the browser whether it fits. Tracking heights manually
  // undercounts collapsed margins and silently clips legal text off the PDF.
  const overflows = () => page.scrollHeight > page.clientHeight;

  // A table too tall for one page is split by row, repeating the header.
  const placeTable = (tbl) => {
    const thead = tbl.querySelector('thead');
    const rows = Array.from(tbl.querySelectorAll('tr')).filter(r => !thead || !thead.contains(r));
    let chunk, tb;
    const startChunk = () => {
      chunk = tbl.cloneNode(false);
      if (thead) chunk.appendChild(thead.cloneNode(true));
      tb = document.createElement('tbody');
      chunk.appendChild(tb);
      page.appendChild(chunk);
    };
    startChunk();
    for (const r of rows) {
      tb.appendChild(r);
      if (overflows() && tb.children.length > 1) {
        tb.removeChild(r);
        newPage();
        startChunk();
        tb.appendChild(r);
      }
    }
    tbl.remove();
  };

  // A list too tall for one page splits by <li>, same idea as the table split.
  // Without this a long <ol> is a single unsplittable block and its tail is
  // clipped off the bottom of the PDF.
  const placeList = (list) => {
    const items = Array.from(list.children);
    let chunk;
    const startChunk = () => {
      chunk = list.cloneNode(false);
      chunk.removeAttribute('start');
      page.appendChild(chunk);
    };
    startChunk();
    let n = 1;
    for (const li of items) {
      chunk.appendChild(li);
      if (overflows() && chunk.children.length > 1) {
        chunk.removeChild(li);
        newPage();
        startChunk();
        if (list.tagName === 'OL') chunk.setAttribute('start', String(n));
        chunk.appendChild(li);
      }
      n += 1;
    }
    list.remove();
  };

  for (const b of blocks) {
    page.appendChild(b);
    if (overflows()) {
      if (page.children.length > 1) { newPage(); page.appendChild(b); }
      if (overflows() && b.tagName === 'TABLE') { placeTable(b); continue; }
      if (overflows() && (b.tagName === 'UL' || b.tagName === 'OL')) { placeList(b); continue; }
    }
  }
  flow.remove();

  // Safety net: a table chunk whose final row pushes it just past the boundary
  // still overflows, and the PDF silently clips it. Walk every page and push its
  // last child forward until nothing overflows. Legal text being cut off the
  // bottom of a page is not a cosmetic defect.
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      let guard = 0;
      while (p.scrollHeight > p.clientHeight && p.children.length > 1 && guard++ < 40) {
        const victim = p.lastElementChild;
        let next = pages[i + 1];
        if (!next) {
          next = document.createElement('div');
          next.className = 'page';
          document.body.appendChild(next);
          pages.push(next);
        }
        next.insertBefore(victim, next.firstChild);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Running footer. Written as a data attribute the CSS renders through
  // ::after, and positioned inside the bottom margin, so adding it cannot change
  // the flow this function just measured. A signed page with no identity and no
  // "3 of 9" is hard to audit and easy to separate.
  pages.forEach((p, i) => {
    p.dataset.foot = `ABR Quality Resources Inc dba Hamilton Exteriors  ·  CSLB 1078806\tPage ${i + 1} of ${pages.length}`;
  });

  // Hard check: nothing may overflow its page, or the PDF will clip it.
  const overflow = pages
    .map((p, i) => ({ i, over: p.scrollHeight - p.clientHeight }))
    .filter(o => o.over > 1);

  // Refine types using DOM context (table column headers etc.)
  const norm = (s) => (s || '').trim().toLowerCase();
  /** Cut to max chars at a word boundary, so a prompt never ends mid-word. */
  const clip = (s, max) => {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s(,;:—-]+$/, '') + '…';
  };
  for (const el of document.querySelectorAll('.ds')) {
    // A checkbox already carries its own option label from build-docs ("Roofer",
    // "Capataz"), which is a far better prompt than the column-header rename
    // would produce ("Position r1"). Leave them alone.
    if (el.dataset.type === 'checkbox') continue;
    const td = el.closest('td');
    if (td) {
      const tr = td.parentElement;
      const idx = Array.from(tr.children).indexOf(td);
      const table = td.closest('table');
      const head = table && table.querySelector('thead tr, tr');
      const th = head && head.children[idx];
      const label = norm(th && th.textContent);
      // "inicial" too: the Spanish column header is "Iniciales", which does NOT
      // contain the English string "initial" (no t) — without this every
      // initials box on the Spanish roster would type as free text.
      if (/initial|inicial/.test(label)) {
        el.dataset.type = 'initials';
        // Name the initial after WHAT is being acknowledged, not the row number.
        // The signer is attesting to receiving a specific document; a prompt
        // reading "Initials r2" asks them to initial 14 legal receipts blind.
        const cells = Array.from(tr.children).filter(c => c !== td);
        const item = cells
          .map(c => c.textContent.trim().replace(/\s+/g, ' '))
          .filter(t => t && !/^\d+$/.test(t))       // drop the row-number column
          .sort((a, b) => b.length - a.length)[0];  // the description is the longest cell
        // Truncate on a word boundary, not mid-word: the raw 70-char cut
        // produced prompts like "...de médico personal (compensación de traba".
        el.dataset.name = item ? clip(item, 70) : `Initials r${tr.rowIndex}`;
      }
      else if (/date|fecha/.test(label)) { el.dataset.type = 'date'; }
      else if (/signature|firma/.test(label)) { el.dataset.type = 'signature'; }
      else if (label) { el.dataset.name = (th.textContent.trim() + ' r' + tr.rowIndex).slice(0, 60); }

      // Label/value tables ("Effective date | ____") put the label in the row's
      // FIRST cell, not a column header. Without this the signer's very first
      // prompt reads "Field 1". In a 2-column table the row label always beats
      // whatever prose happened to precede the blank inside the cell.
      const twoCol = tr.children.length === 2;
      if (twoCol || /^Field \d+$/.test(el.dataset.name || '')) {
        const first = tr.children[0];
        const text = first && first !== td ? first.textContent.trim().replace(/\s+/g, ' ') : '';
        if (text && text.length <= 48 && !/^_+$/.test(text)) {
          el.dataset.name = text;
          if (/date|fecha/i.test(text)) el.dataset.type = 'date';
          else if (/signature|firma/i.test(text)) el.dataset.type = 'signature';
        }
      }
    }
    // Outside tables: fall back to the nearest preceding bold run or heading.
    if (/^Field \d+$/.test(el.dataset.name || '')) {
      let n = el.previousSibling, hops = 0, found = '';
      while (n && hops++ < 4) {
        const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
        if (t && t.length <= 48) { found = t.replace(/[:•\-\s]+$/, ''); break; }
        n = n.previousSibling;
      }
      if (found) {
        el.dataset.name = found;
        if (/date|fecha/i.test(found)) el.dataset.type = 'date';
      }
    }
  }

  // Ownership was decided in build-docs from the PROSE label, before the DOM
  // pass renames the field from its table row. So "Carrier name" was still an
  // unrecognised fragment when ownership was set, and every workers-comp field
  // landed on the Worker — an unanswerable hard stop on the wage notice. Same
  // for the roster's Trainer fields, where a trainee signing "Trainer
  // signature" manufactures a worthless Cal/OSHA 1670 record.
  // Re-decide ownership here, against the FINAL label.
  // Spanish too. The ES wage notice names these "Nombre de la aseguradora" /
  // "Número de póliza", which an English-only pattern misses entirely — so
  // Diego, the one worker who actually gets the Spanish document, would have
  // been the only one still facing the unanswerable carrier fields.
  const EMPLOYER_FILL = new RegExp([
    'carrier', 'policy\\s*(no|number)', 'payday', 'pay period', 'workers?\\s*comp',
    'trainer', 'competent person', 'administrator',
    'aseguradora', 'p[oó]liza', 'd[ií]a de pago', 'per[ií]odo de pago',
    'capacitador', 'instructor', 'persona competente',
  ].join('|'), 'i');
  for (const el of document.querySelectorAll('.ds')) {
    const name = el.dataset.name || '';
    const labelShaped = name.length < 40 && !/[.!?]$/.test(name);
    if (labelShaped && EMPLOYER_FILL.test(name)) el.dataset.owner = 'employer';
  }
  // A bare "Date" belongs to whoever owns the field it follows.
  //
  // The date's own label is just "Date", so the employer rule above misses it
  // and the trainee ends up certifying the dates he was trained on. This used to
  // scope to the shared line, because the source read
  // "Trainer: ______  Date: ______". Those pairs are now split onto separate
  // lines so the field boxes stop wrapping away from their labels, which
  // silently moved 4 trainer dates per roster back onto the Worker. Follow
  // document order instead of the block, so the rule survives the layout.
  const DATE_ONLY = /^(date|fecha)$/i;
  const all = Array.from(document.querySelectorAll('.ds'));
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.dataset.type !== 'date' || el.dataset.owner === 'employer') continue;
    if (!DATE_ONLY.test((el.dataset.name || '').trim())) continue;
    const prev = all[i - 1];
    if (!prev || prev.dataset.owner !== 'employer') continue;
    // Do not inherit across a section boundary: a heading between the two means
    // they are unrelated, and quietly moving a worker's date to the employer is
    // the mirror image of the bug being fixed.
    const block = el.closest('p, td, li') || el;
    const prevBlock = prev.closest('p, td, li') || prev;
    let hop = prevBlock, crossed = false, guard = 0;
    while (hop && hop !== block && guard++ < 20) {
      hop = hop.nextElementSibling;
      if (hop && /^H[1-6]$/.test(hop.tagName)) { crossed = true; break; }
    }
    if (!crossed) el.dataset.owner = 'employer';
  }

  // Measure, page-relative + normalised
  const out = [];
  pages.forEach((p, pi) => {
    const pr = p.getBoundingClientRect();
    for (const el of p.querySelectorAll('.ds')) {
      const r = el.getBoundingClientRect();
      out.push({
        id: el.id,
        name: el.dataset.name,
        section: el.dataset.section || '',
        type: el.dataset.type,
        owner: el.dataset.owner || 'worker',
        page: pi,
        x: +((r.left - pr.left) / w).toFixed(5),
        y: +((r.top - pr.top) / h).toFixed(5),
        w: +(r.width / w).toFixed(5),
        h: +(r.height / h).toFixed(5),
      });
    }
  });
  return { pageCount: pages.length, fields: out, overflow };
};

const browser = await chromium.launch();
const results = [];
for (const m of manifest) {
  const page = await browser.newPage({ viewport: { width: PAGE.w, height: PAGE.h } });
  await page.goto('file:///' + `${DIR}/${m.slug}.html`);
  const res = await page.evaluate(SCRIPT, PAGE);
  // preferCSSPageSize makes the @page rule in build-docs decide the paper, so
  // the print layout is the same width the DOM was measured at. Without it
  // Chromium lays out for its own default sheet and scales the result to fit,
  // which silently divorces the PDF from the coordinates.
  await page.pdf({
    path: `${DIR}/${m.slug}.pdf`,
    width: `${PAGE.w}px`, height: `${PAGE.h}px`,
    preferCSSPageSize: true,
    printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  await page.close();
  // Verify the PDF paginated to exactly the pages we measured against.
  const pdfPages = (readFileSync(`${DIR}/${m.slug}.pdf`).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  const ok = pdfPages === res.pageCount && res.overflow.length === 0;
  const flag = ok ? 'ok' : `PDF=${pdfPages} vs ${res.pageCount}${res.overflow.length ? ' overflow:' + JSON.stringify(res.overflow) : ''}`;
  console.log(`${m.slug.padEnd(34)} pages=${String(res.pageCount).padStart(2)} fields=${String(res.fields.length).padStart(3)}  ${flag}`);
  results.push({ slug: m.slug, pageCount: res.pageCount, pdfPages, fields: res.fields });
}
await browser.close();
writeFileSync(`${DIR}/fields.json`, JSON.stringify(results, null, 2));
console.log('\nwrote build/fields.json');
