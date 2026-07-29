// Load each field-marked HTML, paginate it, refine field types from DOM context,
// measure exact boxes, then emit PDF + DocuSeal-normalised field coordinates.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { BUILD_DIR } from './config.mjs';

const DIR = BUILD_DIR;
// IMPORTED, never redeclared. This file previously carried its own copy of the
// Letter geometry, so changing PAGE in build-docs.mjs silently did nothing: the
// HTML was laid out at phone size while the viewport, the coordinate
// normalisation denominator and page.pdf() all still used 816x1056. The result
// was phone-sized content crammed into the top-left ~45% x 65% of a Letter
// canvas, and every "we fixed legibility" claim was false at the last mile.
// Two constants for one fact is the bug; there is now one.
import { PAGE } from './build-docs.mjs';
import { validateGeneratedGeometry } from './field-geometry.mjs';
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
    if (!overflows()) continue;

    // A table or list that does not fit the REMAINING space is split here and
    // now, filling this page and continuing on the next with the header
    // repeated. It used to be moved whole to a fresh page and only split if it
    // could not fit even a full page, which is what left a page three quarters
    // empty and made the breaks look arbitrary. Splitting a long table across
    // pages is ordinary in a contract; a 640px hole in the middle of one is not.
    if (b.tagName === 'TABLE') { placeTable(b); continue; }
    if (b.tagName === 'UL' || b.tagName === 'OL') { placeList(b); continue; }

    if (page.children.length > 1) { newPage(); page.appendChild(b); }
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

      // Keep a heading with what it introduces. A section title alone at the
      // foot of a page, its body overleaf, is the "weird page break" you notice
      // immediately on a contract: the reader turns the page to find out what
      // the heading was about. Same for a heading whose section then has only a
      // single line under it.
      const pushForward = (el) => {
        let next = pages[i + 1];
        if (!next) {
          next = document.createElement('div');
          next.className = 'page';
          document.body.appendChild(next);
          pages.push(next);
        }
        next.insertBefore(el, next.firstChild);
        moved = true;
      };
      const last = p.lastElementChild;
      // children.length > 1 guard: a page holding nothing but the heading has
      // nowhere better to send it, and moving it forever would not converge.
      if (last && /^H[2-6]$/.test(last.tagName) && p.children.length > 1) {
        pushForward(last);
      } else if (last && p.children.length > 2) {
        // Orphaned heading + one line: move the pair, not just the line.
        const prev = last.previousElementSibling;
        if (prev && /^H[2-6]$/.test(prev.tagName)
            && last.tagName === 'P' && last.getBoundingClientRect().height <= 24) {
          pushForward(last);
          pushForward(prev);
        }
      }
    }
    if (!moved) break;
  }

  // Running footer. Two real children are required: a tab inside one generated
  // string remains one flex item and leaves the page count beside the left copy.
  // Appended after pagination and absolutely positioned in the bottom margin, so
  // it cannot change the flow this function just measured.
  pages.forEach((p, i) => {
    const footer = document.createElement('footer');
    footer.className = 'page-footer';
    const identity = document.createElement('span');
    identity.className = 'page-footer-identity';
    identity.textContent = 'ABR Quality Resources Inc dba Hamilton Exteriors · CSLB 1078806';
    const number = document.createElement('span');
    number.className = 'page-footer-number';
    number.textContent = `Page ${i + 1} of ${pages.length}`;
    footer.append(identity, number);
    const contentLast = p.lastElementChild;
    if (contentLast) contentLast.classList.add('page-content-last');
    p.appendChild(footer);
  });

  // Hard check: nothing may overflow its page, or the PDF will clip it.
  const overflow = pages
    .map((p, i) => ({ i, over: p.scrollHeight - p.clientHeight }))
    .filter(o => o.over > 1);

  // Refine types using DOM context (table column headers etc.)
  const norm = (s) => (s || '').trim().toLowerCase();
  /** Re-decide a field's type from the label the DOM pass just recovered.
   *
   *  build-docs classifies from the text node preceding the blank, which for
   *  "**Carrier telephone:** ____" is only a space: the label lives inside a
   *  separate <strong>. So the type has to be revisited wherever a name gets
   *  repaired. This lived inline in three places and only ever checked date,
   *  which is how a phone field stayed free text. One helper, called from each. */
  const TYPE_CLASS = {
    checkbox: 'ds-box', date: 'ds-date', initials: 'ds-ini',
    phone: 'ds-phone', signature: 'ds-sig', text: '',
  };
  const setType = (el, type, presentation = '') => {
    for (const className of Object.values(TYPE_CLASS)) if (className) el.classList.remove(className);
    const className = presentation === 'phone' ? TYPE_CLASS.phone : TYPE_CLASS[type];
    if (className) el.classList.add(className);
    el.dataset.type = type;
    if (presentation) el.dataset.presentation = presentation;
    else delete el.dataset.presentation;
  };
  const retype = (el, label) => {
    const t = norm(label);
    if (!t) return;
    if (/^administrator phone$/i.test(t)) setType(el, 'text', 'phone');
    else if (/\bdate\b|\bfecha\b|\breviewed\s*\/\s*updated\b/.test(t)) setType(el, 'date');
    else if (/signature|firma/.test(t)) setType(el, 'signature');
    else if (/\bphone\b|\btelephone\b|\btel[eé]fono\b|\bcelular\b/.test(t)) setType(el, 'phone');
  };
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
        setType(el, 'initials');
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
      else if (/date|fecha/.test(label)) { setType(el, 'date'); }
      else if (/signature|firma/.test(label)) { setType(el, 'signature'); }
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
          retype(el, text);
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
        retype(el, found);
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
        ...(el.dataset.presentation ? { presentation: el.dataset.presentation } : {}),
        owner: el.dataset.owner || 'worker',
        page: pi,
        x: +((r.left - pr.left) / w).toFixed(5),
        y: +((r.top - pr.top) / h).toFixed(5),
        w: +(r.width / w).toFixed(5),
        h: +(r.height / h).toFixed(5),
      });
    }
  });
  const footers = pages.map((p, pageIndex) => {
    const pageRect = p.getBoundingClientRect();
    const footer = p.querySelector('.page-footer');
    const identity = footer && footer.querySelector('.page-footer-identity');
    const number = footer && footer.querySelector('.page-footer-number');
    const footerRect = footer && footer.getBoundingClientRect();
    const identityRect = identity && identity.getBoundingClientRect();
    const numberRect = number && number.getBoundingClientRect();
    return {
      page: pageIndex,
      count: p.querySelectorAll('.page-footer').length,
      identity: identity && identity.textContent,
      number: number && number.textContent,
      left: identityRect && +(identityRect.left - pageRect.left).toFixed(2),
      right: numberRect && +(pageRect.right - numberRect.right).toFixed(2),
      top: footerRect && +(footerRect.top - pageRect.top).toFixed(2),
      bottom: footerRect && +(pageRect.bottom - footerRect.bottom).toFixed(2),
    };
  });
  const footerProblems = footers.filter((footer) =>
    footer.count !== 1 ||
    footer.identity !== 'ABR Quality Resources Inc dba Hamilton Exteriors · CSLB 1078806' ||
    footer.number !== `Page ${footer.page + 1} of ${pages.length}` ||
    Math.abs(footer.left - ml) > 1 || Math.abs(footer.right - mr) > 1 ||
    footer.top < h - mb || footer.bottom < 0);
  return { pageCount: pages.length, fields: out, overflow, footers, footerProblems };
};

const browser = await chromium.launch();
const results = [];
const failures = [];
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
  const geometryProblems = validateGeneratedGeometry({ pageCount: res.pageCount, fields: res.fields });
  const ok = pdfPages === res.pageCount && res.overflow.length === 0 &&
    res.footerProblems.length === 0 && geometryProblems.length === 0 &&
    res.fields.length === m.fields.length;
  const details = [];
  if (pdfPages !== res.pageCount) details.push(`PDF=${pdfPages} vs ${res.pageCount}`);
  if (res.overflow.length) details.push(`overflow:${JSON.stringify(res.overflow)}`);
  if (res.footerProblems.length) details.push(`footer:${JSON.stringify(res.footerProblems)}`);
  if (geometryProblems.length) details.push(`geometry:${JSON.stringify(geometryProblems)}`);
  if (res.fields.length !== m.fields.length) details.push(`fields=${res.fields.length} vs ${m.fields.length}`);
  const flag = ok ? 'ok' : details.join(' ');
  console.log(`${m.slug.padEnd(34)} pages=${String(res.pageCount).padStart(2)} fields=${String(res.fields.length).padStart(3)}  ${flag}`);
  if (!ok) failures.push(`${m.slug}: ${flag}`);
  results.push({ slug: m.slug, pageCount: res.pageCount, pdfPages, footers: res.footers, fields: res.fields });
}
await browser.close();
if (failures.length) {
  throw new Error(`measurement failed; fields.json not written:\n${failures.join('\n')}`);
}
writeFileSync(`${DIR}/fields.json`, JSON.stringify(results, null, 2));
console.log('\nwrote build/fields.json');
