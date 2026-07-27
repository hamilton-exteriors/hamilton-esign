// Load each field-marked HTML, paginate it, refine field types from DOM context,
// measure exact boxes, then emit PDF + DocuSeal-normalised field coordinates.
import { readFileSync, writeFileSync } from 'node:fs';
import pw from 'file:///C:/Users/admin/AppData/Roaming/npm/node_modules/playwright/index.js';
const { chromium } = pw;

const DIR = 'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin/d1994a65-4339-4973-8fe3-b31c96359079/scratchpad/build';
const PAGE = { w: 816, h: 1056, mt: 120, mb: 96, ml: 144, mr: 120 };
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

  for (const b of blocks) {
    page.appendChild(b);
    if (overflows()) {
      if (page.children.length > 1) { newPage(); page.appendChild(b); }
      if (overflows() && b.tagName === 'TABLE') { placeTable(b); continue; }
    }
  }
  flow.remove();

  // Hard check: nothing may overflow its page, or the PDF will clip it.
  const overflow = pages
    .map((p, i) => ({ i, over: p.scrollHeight - p.clientHeight }))
    .filter(o => o.over > 1);

  // Refine types using DOM context (table column headers etc.)
  const norm = (s) => (s || '').trim().toLowerCase();
  for (const el of document.querySelectorAll('.ds')) {
    const td = el.closest('td');
    if (td) {
      const tr = td.parentElement;
      const idx = Array.from(tr.children).indexOf(td);
      const table = td.closest('table');
      const head = table && table.querySelector('thead tr, tr');
      const th = head && head.children[idx];
      const label = norm(th && th.textContent);
      if (/initial/.test(label)) {
        el.dataset.type = 'initials';
        // Name the initial after WHAT is being acknowledged, not the row number.
        // The signer is attesting to receiving a specific document; a prompt
        // reading "Initials r2" asks them to initial 14 legal receipts blind.
        const cells = Array.from(tr.children).filter(c => c !== td);
        const item = cells
          .map(c => c.textContent.trim().replace(/\s+/g, ' '))
          .filter(t => t && !/^\d+$/.test(t))       // drop the row-number column
          .sort((a, b) => b.length - a.length)[0];  // the description is the longest cell
        el.dataset.name = item ? item.slice(0, 70) : `Initials r${tr.rowIndex}`;
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

  // Measure, page-relative + normalised
  const out = [];
  pages.forEach((p, pi) => {
    const pr = p.getBoundingClientRect();
    for (const el of p.querySelectorAll('.ds')) {
      const r = el.getBoundingClientRect();
      out.push({
        id: el.id,
        name: el.dataset.name,
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
  await page.pdf({
    path: `${DIR}/${m.slug}.pdf`,
    width: `${PAGE.w}px`, height: `${PAGE.h}px`,
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
