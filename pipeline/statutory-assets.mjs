import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const AUTHORITATIVE_HOSTS = new Set(['www.dir.ca.gov', 'edd.ca.gov', 'calcivilrights.ca.gov', 'www.calcivilrights.ca.gov']);

export const STATUTORY_PAMPHLETS = {
  en: [
    { key: 'dwc-time-of-hire', row: 3, name: 'DWC Time of Hire pamphlet', url: 'https://www.dir.ca.gov/dwc/DWCPamphlets/TimeOfHireNotice.pdf' },
    { key: 'dwc-predesignation', row: 4, name: 'Predesignation of personal physician (DWC 9783)', url: 'https://www.dir.ca.gov/dwc/forms/dwcform_9783.pdf' },
    { key: 'de-2320', row: 5, name: 'DE 2320 For Your Benefit', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2320.pdf' },
    { key: 'de-2515', row: 6, name: 'DE 2515 Disability Insurance Provisions', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2515.pdf' },
    { key: 'de-2511', row: 7, name: 'DE 2511 Paid Family Leave', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2511.pdf' },
    { key: 'paid-sick-leave', row: 8, name: 'Paid sick leave notice', url: 'https://www.dir.ca.gov/dlse/Publications/Paid_Sick_Days_Poster_Template_(11_2014).pdf' },
    { key: 'crd-sexual-harassment', row: 9, name: 'Sexual harassment prevention (CRD)', url: 'https://www.calcivilrights.ca.gov/wp-content/uploads/sites/32/2022/12/Sexual-Harassment-Poster_ENG.pdf' },
    { key: 'victims-rights', row: 10, name: 'Rights of victims of domestic violence, sexual assault and stalking', url: 'https://www.dir.ca.gov/dlse/victims_of_domestic_violence_leave_notice.pdf' },
  ],
  es: [
    { key: 'dwc-time-of-hire-es', row: 3, name: 'Folleto DWC al momento de contratación', url: 'https://www.dir.ca.gov/dwc/DWCPamphlets/TimeOfHireNotice_Spanish.pdf' },
    { key: 'dwc-predesignation', row: 4, name: 'Predesignación de médico personal (formulario oficial en inglés)', language: 'en', url: 'https://www.dir.ca.gov/dwc/forms/dwcform_9783.pdf' },
    { key: 'de-2320-es', row: 5, name: 'DE 2320 Para Su Beneficio', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2320s.pdf' },
    { key: 'de-2515-es', row: 6, name: 'DE 2515 Seguro de Incapacidad', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2515s.pdf' },
    { key: 'de-2511-es', row: 7, name: 'DE 2511 Permiso Familiar Pagado', url: 'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de2511s.pdf' },
    { key: 'paid-sick-leave', row: 8, name: 'Aviso oficial de días de enfermedad pagados (en inglés)', language: 'en', url: 'https://www.dir.ca.gov/dlse/Publications/Paid_Sick_Days_Poster_Template_(11_2014).pdf' },
    { key: 'crd-sexual-harassment-es', row: 9, name: 'Acoso sexual - hoja informativa (CRD)', url: 'https://www.calcivilrights.ca.gov/wp-content/uploads/sites/32/2020/04/Sexual-Harassment-Fact-Sheet_SP.pdf' },
    { key: 'victims-rights-es', row: 10, name: 'Derechos de víctimas de violencia doméstica, agresión sexual y acecho', url: 'https://www.dir.ca.gov/dlse/Victims_of_Domestic_Violence_Leave_Notice_Spanish.pdf' },
  ],
};

export function statutorySources(language) {
  return STATUTORY_PAMPHLETS[language].map((asset) => ({
    kind: 'pdf',
    slug: `statutory-${asset.key}`,
    title: asset.name,
    url: asset.url,
    language: asset.language || language,
  }));
}

function assertAuthoritativeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !AUTHORITATIVE_HOSTS.has(url.hostname)) {
    throw new Error(`statutory asset URL is not on an approved authoritative host: ${value}`);
  }
}

export function loadStatutoryLock(lockPath) {
  let value;
  try { value = JSON.parse(readFileSync(lockPath, 'utf8')); }
  catch (error) { throw new Error(`cannot read statutory lock ${lockPath}: ${error.message}`); }
  if (value?.schemaVersion !== 1 || !Array.isArray(value.assets)) {
    throw new Error('statutory lock schema is invalid');
  }
  const assets = new Map();
  for (const asset of value.assets) {
    if (!asset?.slug || assets.has(asset.slug) || basename(asset.filename || '') !== asset.filename ||
      !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isInteger(asset.bytes) || asset.bytes < 1024 ||
      !Number.isInteger(asset.pageCount) || asset.pageCount <= 0) {
      throw new Error(`statutory lock entry ${asset?.slug || '<unknown>'} is invalid`);
    }
    assertAuthoritativeUrl(asset.url);
    assets.set(asset.slug, asset);
  }
  return assets;
}

export function loadPinnedStatutoryPdf(source, assetDir, lockPath) {
  const expected = loadStatutoryLock(lockPath).get(source.slug);
  if (!expected || expected.url !== source.url) {
    throw new Error(`${source.slug}: source is absent from the immutable statutory lock`);
  }
  const path = resolve(assetDir, expected.filename);
  const bytes = readFileSync(path);
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256 ||
    bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`${source.slug}: pinned statutory asset does not match its immutable lock`);
  }
  return { path, bytes, sha256: expected.sha256, pageCount: expected.pageCount };
}

export async function fetchStatutoryPdf(source, buildDir, expected, fetchImpl = fetch) {
  assertAuthoritativeUrl(source.url);
  if (!expected || expected.slug !== source.slug || expected.url !== source.url ||
    !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) {
    throw new Error(`${source.slug}: expected SHA lock is required before network fetch`);
  }
  const response = await fetchImpl(source.url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Hamilton-Esign-Build/1.0' },
  });
  if (!response.ok) throw new Error(`${source.slug}: statutory PDF returned ${response.status}`);
  if (response.url) assertAuthoritativeUrl(response.url);
  const contentType = response.headers.get('content-type') || '';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!/pdf/i.test(contentType) || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`${source.slug}: authoritative response is not a PDF`);
  }
  if (bytes.length < 1024 || bytes.length > 30 * 1024 * 1024) {
    throw new Error(`${source.slug}: statutory PDF size is outside the safe build range`);
  }
  const digest = sha256(bytes);
  if (bytes.length !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`${source.slug}: authoritative response does not match the expected SHA lock`);
  }
  const dir = resolve(buildDir, 'statutory');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${source.slug}.pdf`);
  writeFileSync(path, bytes);
  return { path, bytes, sha256: digest, pageCount: expected.pageCount };
}

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function orderStatutoryTextItems(items, viewport) {
  const normalized = items.map((item) => {
    const text = String(item.str || '').trim();
    const [x, y] = viewport.convertToViewportPoint(
      Number(item.transform?.[4] || 0),
      Number(item.transform?.[5] || 0),
    );
    const width = Math.abs(Number(item.width || 0) * Number(viewport.scale || 1));
    return { text, x, y, width };
  }).filter((item) => item.text);

  const lines = (entries) => {
    const groups = [];
    for (const item of [...entries].sort((a, b) => a.y - b.y || a.x - b.x)) {
      let line = groups.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
      if (!line) { line = { y: item.y, items: [] }; groups.push(line); }
      line.items.push(item);
    }
    return groups.sort((a, b) => a.y - b.y).map((line) =>
      line.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' '));
  };

  // Agency handouts are often imposed as equal-width brochure panels. DE-2515/S
  // is the important real case: a 1224x612 sheet has four 306-point panels. A
  // half-page split puts panels 1+2 and 3+4 into the same buckets, then sorts each
  // pair by Y and interleaves unrelated sentences. Infer the narrowest plausible
  // panel grid from the actual page geometry and text boxes, then read every panel
  // top-to-bottom and the panels left-to-right.
  const pageWidth = Number(viewport.width || 0);
  const pageHeight = Number(viewport.height || 0);
  const aspect = pageHeight > 0 ? pageWidth / pageHeight : 1;
  const maximumColumns = aspect >= 1.75 ? 4 : aspect >= 1.25 ? 3 : 2;
  let columns = 1;
  let columnItems = [normalized];
  let spanning = [];
  for (let count = maximumColumns; count >= 2; count--) {
    const columnWidth = pageWidth / count;
    const candidates = Array.from({ length: count }, () => []);
    const wide = [];
    for (const item of normalized) {
      if (item.width > columnWidth * 1.2) {
        wide.push(item);
        continue;
      }
      // Use the text origin rather than its midpoint. A complete line commonly
      // reaches across a geometric gutter, but it still belongs to the panel in
      // which the line starts.
      const index = Math.max(0, Math.min(count - 1, Math.floor(item.x / columnWidth)));
      candidates[index].push(item);
    }
    const enoughText = candidates.every((entries) => entries.length >= 3);
    const fitted = normalized.length === 0 ? 0 : 1 - wide.length / normalized.length;
    if (enoughText && fitted >= 0.82) {
      columns = count;
      columnItems = candidates;
      spanning = wide;
      break;
    }
  }
  if (columns === 1) {
    const orderedLines = lines(normalized);
    return { columns, lines: orderedLines, panels: [orderedLines] };
  }

  const firstColumnY = Math.min(...columnItems.flatMap((entries) => entries.map((item) => item.y)));
  const lastColumnY = Math.max(...columnItems.flatMap((entries) => entries.map((item) => item.y)));
  const top = spanning.filter((item) => item.y < firstColumnY);
  const bottom = spanning.filter((item) => item.y > lastColumnY);
  const middle = spanning.filter((item) => !top.includes(item) && !bottom.includes(item));
  const panelLines = columnItems.map((entries) => lines(entries));
  return {
    columns,
    panels: panelLines,
    lines: [
      ...lines(top),
      ...panelLines.flat(),
      ...lines(middle),
      ...lines(bottom),
    ],
  };
}

export async function locateStatutoryFooterMasks(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true });
  const pdf = await task.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const low = content.items.map((item) => ({
        text: String(item.str || '').trim(),
        x: Number(item.transform?.[4] || 0),
        y: Number(item.transform?.[5] || 0),
        width: Math.abs(Number(item.width || 0)),
        height: Math.max(6, Math.abs(Number(item.height || item.transform?.[3] || 0))),
      })).filter((item) => item.text && item.y < 45);
      const groups = [];
      for (const item of low.sort((a, b) => a.y - b.y || a.x - b.x)) {
        let group = groups.find((candidate) => Math.abs(candidate.y - item.y) <= 1);
        if (!group) { group = { y: item.y, items: [] }; groups.push(group); }
        group.items.push(item);
      }
      const masks = [];
      for (const group of groups) {
        const items = group.items.sort((a, b) => a.x - b.x);
        const text = items.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
        const stale = /(?:\bpage|página)\s*\d+\s*(?:of|de)\s*\d+/i.test(text) ||
          /\bDE\s*\d+(?:\s*\/\s*S)?\s+Rev\./i.test(text) || /\bINTERNET\b/i.test(text) ||
          /\bCRD-\d+/i.test(text) || /DLSE Paid Sick Leave Posting/i.test(text) ||
          /(?:Effective for dates of injury|En vigor para las fechas de lesiones)/i.test(text) ||
          /(?:Revised|Revisado)\s+(?:on\s+)?(?:el\s+)?\d/i.test(text) ||
          (/^\d{1,3}$/.test(text) && group.y < 35);
        if (!stale) continue;
        const left = Math.min(...items.map((item) => item.x));
        const right = Math.max(...items.map((item) => item.x + item.width));
        const bottom = Math.min(...items.map((item) => item.y));
        const top = Math.max(...items.map((item) => item.y + item.height));
        masks.push({ x: left - 2, y: bottom - 2, width: right - left + 4, height: top - bottom + 4 });
      }
      pages.push(masks);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

const BROCHURE_READER_ORDER = new Map([
  // The cached Spanish DE-2515 is a two-sided, four-panel folded brochure, not
  // four ordinary LTR columns. Its real content sequence is established by the
  // agency headings on the artwork: front cover; definitions; pregnancy/care;
  // application; next steps; calculation; rights/contact; administrative back.
  // Physical coordinates are zero-based [PDF page, panel from the left].
  ['statutory-de-2515-es', [
    [0, 3], [0, 1], [0, 0],
    [1, 0], [1, 1], [1, 2], [1, 3],
    [0, 2],
  ]],
]);

export async function statutoryPdfToReflow(source, bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true });
  const pdf = await task.promise;
  const extractedPages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      const ordered = orderStatutoryTextItems(content.items, viewport);
      const readableCharacters = ordered.lines.join(' ').replace(/\s+/g, '').length;
      if (readableCharacters < 20) {
        throw new Error(`${source.slug}: statutory PDF page ${pageNumber} has no complete readable text layer`);
      }
      extractedPages.push({ pageNumber, ordered });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  const readerOrder = BROCHURE_READER_ORDER.get(source.slug);
  let pages;
  if (readerOrder) {
    const invalid = readerOrder.some(([pageIndex, panelIndex]) =>
      !extractedPages[pageIndex]?.ordered.panels?.[panelIndex]);
    if (invalid || extractedPages.some(({ ordered }) => ordered.columns !== 4)) {
      throw new Error(`${source.slug}: cached brochure geometry no longer matches its verified reader order`);
    }
    const paragraphs = readerOrder
      .flatMap(([pageIndex, panelIndex]) => extractedPages[pageIndex].ordered.panels[panelIndex])
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('\n');
    pages = [`<section class="hx-statutory-page" data-source-slug="${source.slug}" data-columns="4" ` +
      `data-reader-order="p1c4,p1c2,p1c1,p2c1,p2c2,p2c3,p2c4,p1c3">` +
      `<h3>${escapeHtml(source.title)}</h3>${paragraphs}</section>`];
  } else {
    pages = extractedPages.map(({ pageNumber, ordered }) => {
      const paragraphs = ordered.lines
        .filter(Boolean)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('\n');
      return `<section class="hx-statutory-page" data-source-slug="${source.slug}" data-columns="${ordered.columns}">` +
        `<h3>${escapeHtml(source.title)} - ${source.language === 'es' ? 'página' : 'page'} ${pageNumber} ${source.language === 'es' ? 'de' : 'of'} ${pdf.numPages}</h3>` +
        paragraphs + '</section>';
    });
  }
  if (!pages.length || pages.every((page) => !/<p>/.test(page))) {
    throw new Error(`${source.slug}: statutory PDF yielded no readable text for reflow`);
  }
  return { html: pages.join('\n'), pageCount: extractedPages.length };
}

export function readBuiltStatutoryPdf(source, buildDir) {
  return readFileSync(resolve(buildDir, 'statutory', `${source.slug}.pdf`));
}
