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
      if (/initial/.test(label)) { el.dataset.type = 'initials'; el.dataset.name = `Initials r${tr.rowIndex}`; }
      else if (/date|fecha/.test(label)) { el.dataset.type = 'date'; }
      else if (/signature|firma/.test(label)) { el.dataset.type = 'signature'; }
      else if (label) { el.dataset.name = (th.textContent.trim() + ' r' + tr.rowIndex).slice(0, 60); }
    }
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
