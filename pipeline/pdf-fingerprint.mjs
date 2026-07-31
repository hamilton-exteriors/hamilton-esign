import { createHash } from 'node:crypto';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { PDFJS_NODE_ASSETS } from './pdfjs-assets.mjs';

globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;

const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');

export const PDF_FINGERPRINT_ALGORITHM = 'hamilton-pdf-semantic-visual-v1';
export const PDF_FINGERPRINT_SCALE = 2;
const OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([name, value]) => [value, name]));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const round = (value) => {
  if (!Number.isFinite(value)) throw new Error('PDF fingerprint encountered nonfinite geometry');
  return Number(value.toFixed(6));
};
const canonicalJson = (value) => JSON.stringify(value);

function canonicalOperatorValue(value) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return round(value);
  if (typeof value === 'string') return value.replace(/^g_d\d+_/, 'g_d*_');
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      length: value.length,
      sha256: sha256(Buffer.from(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (value instanceof ArrayBuffer) return { length: value.byteLength, sha256: sha256(Buffer.from(value)) };
  if (Array.isArray(value)) return value.map(canonicalOperatorValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => !['bitmap', 'data'].includes(key))
      .map((key) => [key, canonicalOperatorValue(value[key])]));
  }
  throw new Error(`PDF fingerprint encountered unsupported operator value ${typeof value}`);
}

function canonicalAnnotation(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return round(value);
  if (Array.isArray(value)) return value.map(canonicalAnnotation);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      // Object-reference identities may change during benign PDF reserialization.
      .filter((key) => !['id', 'parentId'].includes(key))
      .map((key) => [key, canonicalAnnotation(value[key])]));
  }
  throw new Error(`PDF fingerprint encountered unsupported annotation value ${typeof value}`);
}

function canonicalTextItem(item) {
  if (!item || typeof item.str !== 'string' || !Array.isArray(item.transform) || item.transform.length !== 6) {
    throw new Error('PDF fingerprint encountered malformed text content');
  }
  return {
    str: item.str.normalize('NFC'),
    dir: item.dir || '',
    width: round(item.width),
    height: round(item.height),
    transform: item.transform.map(round),
    hasEOL: Boolean(item.hasEOL),
  };
}

export async function fingerprintPdf(bytes, { scale = PDF_FINGERPRINT_SCALE } = {}) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) throw new Error('PDF fingerprint bytes are required');
  if (!bytes.byteLength || !Number.isFinite(scale) || scale <= 0) throw new Error('PDF fingerprint input is invalid');
  // PDF.js may take ownership of its input buffer. Always copy caller-owned bytes.
  const loadingTask = getDocument({ data: new Uint8Array(bytes), disableWorker: true, ...PDFJS_NODE_ASSETS });
  const pdf = await loadingTask.promise;
  if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('PDF fingerprint requires at least one page');
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const geometry = {
        view: page.view.map(round),
        rotate: page.rotate,
        userUnit: round(page.userUnit),
        width: round(viewport.width),
        height: round(viewport.height),
      };
      const textContent = await page.getTextContent();
      const text = textContent.items.map(canonicalTextItem);
      const annotations = (await page.getAnnotations({ intent: 'display' })).map(canonicalAnnotation);
      const operatorList = await page.getOperatorList();
      const operators = operatorList.fnArray.map((fn, index) => ({
        fn: OP_NAMES[fn] || fn,
        args: canonicalOperatorValue(operatorList.argsArray[index]),
      }));
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (width < 1 || height < 1) throw new Error(`PDF fingerprint page ${pageNumber} has invalid dimensions`);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
      const pixels = Buffer.from(context.getImageData(0, 0, width, height).data);
      pages.push({
        page: pageNumber,
        geometrySha256: sha256(canonicalJson(geometry)),
        textSha256: sha256(canonicalJson(text)),
        annotationSha256: sha256(canonicalJson(annotations)),
        operatorSha256: sha256(canonicalJson(operators)),
        visualSha256: sha256(pixels),
        textItems: text.length,
        annotations: annotations.length,
        operators: operators.length,
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  const semanticPages = pages.map(({ page, geometrySha256, textSha256, annotationSha256 }) => ({
    page, geometrySha256, textSha256, annotationSha256,
  }));
  const visualPages = pages.map(({ page, geometrySha256, visualSha256 }) => ({ page, geometrySha256, visualSha256 }));
  return Object.freeze({
    algorithm: PDF_FINGERPRINT_ALGORITHM,
    scale,
    pageCount: pages.length,
    semanticSha256: sha256(`${PDF_FINGERPRINT_ALGORITHM}:semantic:${canonicalJson(semanticPages)}`),
    visualSha256: sha256(`${PDF_FINGERPRINT_ALGORITHM}:visual:${canonicalJson(visualPages)}`),
    operatorSha256: sha256(`${PDF_FINGERPRINT_ALGORITHM}:operators:${canonicalJson(pages.map(({ page, operatorSha256 }) => ({ page, operatorSha256 })))}`),
    pages,
  });
}

export function validatePdfFingerprint(value, label = 'PDF fingerprint') {
  if (!value || value.algorithm !== PDF_FINGERPRINT_ALGORITHM || value.scale !== PDF_FINGERPRINT_SCALE ||
    !Number.isInteger(value.pageCount) || value.pageCount < 1 ||
    ![value.semanticSha256, value.visualSha256, value.operatorSha256].every((hash) => /^[a-f0-9]{64}$/.test(hash || '')) ||
    !Array.isArray(value.pages) || value.pages.length !== value.pageCount) {
    throw new Error(`${label} is invalid or uses an unsupported algorithm`);
  }
  return value;
}

export function fingerprintsEqual(left, right) {
  validatePdfFingerprint(left, 'local PDF fingerprint');
  validatePdfFingerprint(right, 'provider PDF fingerprint');
  return left.semanticSha256 === right.semanticSha256 &&
    left.visualSha256 === right.visualSha256 &&
    left.operatorSha256 === right.operatorSha256;
}
