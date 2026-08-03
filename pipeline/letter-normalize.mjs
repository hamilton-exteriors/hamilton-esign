// Normalize statutory source pages to exactly US Letter portrait (612x792pt).
//
// The v3 packet embedded government PDFs at native size, so one executed packet
// mixed five paper sizes: Letter, half-letter pamphlets (396x612), an 11x8.5
// landscape spread, a 17x8.5 folded brochure, and an 11x17 poster. The owner
// reviewed the executed PDF and rejected the look; v4 places every source page
// on a Letter portrait sheet instead:
//
//   - portrait-or-square pages scale uniformly to fit (min(612/w, 792/h)) and
//     are centered on both axes — the half-letter pamphlets upscale ~1.29x by
//     design;
//   - landscape pages (w > h) rotate 90 degrees counterclockwise first, the
//     standard print convention (top of the landscape artwork lands on the left
//     edge, so the reader turns the printed page clockwise), then fit + center;
//   - the 11x17 CRD poster is portrait, so it is fit, never rotated.
//
// Content is embedded as a vector Form XObject and transformed — never
// rasterized — so text stays selectable/extractable and the verification stack
// can keep fingerprinting extracted text.
//
// The v5 generation additionally crops each source page to its measured ink
// bounding box (plus an 8pt pad) before the same fit-and-center placement, so
// government artwork spans the Letter content box instead of importing its own
// paper margins. Cropping is an adjusted bounding box on the embedded page —
// the vector content is untouched and no ink is ever clipped: the box is the
// measured extent of every non-white pixel at a conservative threshold.
import { PDFDocument, PDFName, degrees, rgb } from 'pdf-lib';

export const LETTER_PAGE = Object.freeze({ width: 612, height: 792 });

// v5 statutory placement box: 28pt side margins (the Letter content box) and a
// 24pt bottom reserve so placed artwork always clears the stamped running
// footer (its white-out band on statutory pages is 14pt; the footer text top is
// ~14pt). Upscale is capped at 4:3 — the established half-letter-pamphlet
// upscale — so a sparse page can never be grotesquely magnified.
export const INK_FIT_BOX = Object.freeze({ left: 28, right: 584, bottom: 24, top: 784 });
export const INK_FIT_PAD = 8;
export const INK_FIT_MAX_SCALE = 4 / 3;
// Conservative: any pixel any channel below this is ink. The faint artwork on
// the DE 2320 pamphlets (~y 19pt) only registers above ~200, and cropping a
// legal notice's faint ink would be clipping it.
export const INK_THRESHOLD = 245;

/** Pure placement math for one source page onto a Letter portrait sheet.
 *  Returns the drawPage() arguments plus the placed bounding box for checks. */
export function letterPlacement(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('letter placement requires positive finite source page dimensions');
  }
  const landscape = width > height;
  // Horizontal/vertical extent of the source once oriented for the portrait sheet.
  const orientedWidth = landscape ? height : width;
  const orientedHeight = landscape ? width : height;
  const scale = Math.min(LETTER_PAGE.width / orientedWidth, LETTER_PAGE.height / orientedHeight);
  const placedWidth = orientedWidth * scale;
  const placedHeight = orientedHeight * scale;
  const left = (LETTER_PAGE.width - placedWidth) / 2;
  const bottom = (LETTER_PAGE.height - placedHeight) / 2;
  return {
    rotateDegrees: landscape ? 90 : 0,
    scale,
    // drawPage() rotates counterclockwise about (x, y), so a 90-degree draw
    // extends left of x and above y: anchor the rotation point at the placed
    // box's bottom-RIGHT corner. Unrotated draws extend right/up from (x, y).
    x: landscape ? left + placedWidth : left,
    y: bottom,
    bounds: { left, bottom, width: placedWidth, height: placedHeight },
  };
}

/** The transform above assumes an unrotated page whose content region starts at
 *  the origin. Every pinned statutory asset satisfies this; fail closed if a
 *  refreshed asset ever does not, rather than silently mis-placing content. */
export function assertNormalizableSourcePage(page, label) {
  const rotation = page.getRotation().angle;
  if (rotation !== 0) {
    throw new Error(`${label}: source page /Rotate ${rotation} is unsupported for letter normalization`);
  }
  const media = page.getMediaBox();
  if (media.x !== 0 || media.y !== 0) {
    throw new Error(`${label}: source page MediaBox origin ${media.x},${media.y} must be 0,0`);
  }
  const crop = page.getCropBox();
  if (crop.x !== media.x || crop.y !== media.y || crop.width !== media.width || crop.height !== media.height) {
    throw new Error(`${label}: source page CropBox must equal its MediaBox`);
  }
  return media;
}

/** Pure v5 placement math: fit one padded crop box onto the Letter sheet.
 *  Rotation follows the SOURCE PAGE orientation, never the crop aspect — a
 *  portrait notice whose remaining ink happens to be a short wide block must
 *  stay upright, not turn sideways. Upscale is capped at INK_FIT_MAX_SCALE. */
export function inkFitPlacement(pageSize, crop) {
  const pageWidth = Number(pageSize?.width);
  const pageHeight = Number(pageSize?.height);
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
    throw new Error('ink-fit placement requires positive finite source page dimensions');
  }
  const cropWidth = crop.right - crop.left;
  const cropHeight = crop.top - crop.bottom;
  if (!(cropWidth > 0) || !(cropHeight > 0)) {
    throw new Error('ink-fit placement requires a positive crop box');
  }
  const landscape = pageWidth > pageHeight;
  const orientedWidth = landscape ? cropHeight : cropWidth;
  const orientedHeight = landscape ? cropWidth : cropHeight;
  const boxWidth = INK_FIT_BOX.right - INK_FIT_BOX.left;
  const boxHeight = INK_FIT_BOX.top - INK_FIT_BOX.bottom;
  const scale = Math.min(boxWidth / orientedWidth, boxHeight / orientedHeight, INK_FIT_MAX_SCALE);
  const placedWidth = orientedWidth * scale;
  const placedHeight = orientedHeight * scale;
  const left = INK_FIT_BOX.left + (boxWidth - placedWidth) / 2;
  const bottom = INK_FIT_BOX.bottom + (boxHeight - placedHeight) / 2;
  return {
    rotateDegrees: landscape ? 90 : 0,
    scale,
    // Same anchor rule as letterPlacement: a 90-degree draw extends left of x
    // and above y, so anchor at the placed box's bottom-right corner.
    x: landscape ? left + placedWidth : left,
    y: bottom,
    bounds: { left, bottom, width: placedWidth, height: placedHeight },
  };
}

/** Scan rendered RGBA pixels for the ink bounding box, in PDF points.
 *  Canvas rows run top-down; PDF y runs up. Returns null for a blank page. */
export function inkBoundingBoxFromPixels(data, width, height, scale, pageHeightPt, threshold = INK_THRESHOLD) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index] < threshold || data[index + 1] < threshold || data[index + 2] < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    left: minX / scale,
    right: (maxX + 1) / scale,
    bottom: pageHeightPt - (maxY + 1) / scale,
    top: pageHeightPt - minY / scale,
  };
}

/** Pad an ink box and clamp it to its page. The pad keeps a small visual quiet
 *  zone and absorbs the half-pixel measurement quantization; clamping means the
 *  crop can never exceed the page it came from. */
export function paddedCropBox(ink, pageWidth, pageHeight, pad = INK_FIT_PAD) {
  return {
    left: Math.max(0, ink.left - pad),
    bottom: Math.max(0, ink.bottom - pad),
    right: Math.min(pageWidth, ink.right + pad),
    top: Math.min(pageHeight, ink.top + pad),
  };
}

/** Load one statutory source, strip its interactive layer, mask its stale
 *  footers in SOURCE space, then append each page to `output` as a Letter
 *  portrait page carrying the source content as a transformed vector XObject.
 *  Returns the per-page placements actually drawn. */
export async function appendLetterNormalizedStatutoryPages({ output, statutoryBytes, footerMasks, expectedPageCount, label }) {
  const statutory = await PDFDocument.load(statutoryBytes, { ignoreEncryption: true, updateMetadata: false });
  // Statutory inserts are read-only evidence, never signer forms. Remove the
  // complete interactive layer before embedding; several agency PDFs contain
  // malformed legacy widget metadata that pdf-lib cannot flatten safely.
  statutory.catalog.delete(PDFName.of('AcroForm'));
  for (const page of statutory.getPages()) page.node.delete(PDFName.of('Annots'));
  if (statutory.catalog.get(PDFName.of('AcroForm')) ||
    statutory.getPages().some((page) => page.node.get(PDFName.of('Annots')))) {
    throw new Error(`${label}: could not remove statutory widgets before letter normalization`);
  }
  const pages = statutory.getPages();
  if (pages.length !== expectedPageCount) {
    throw new Error(`${label}: statutory source page count changed during letter normalization`);
  }
  if (!Array.isArray(footerMasks) || footerMasks.length !== pages.length) {
    throw new Error(`${label}: statutory footer scan does not cover every source page`);
  }
  pages.forEach((page, index) => {
    assertNormalizableSourcePage(page, `${label} page ${index + 1}`);
    // Masks are computed and drawn in source page space, before the transform,
    // so they cover exactly the stale source footer text they were measured on.
    const { width, height } = page.getSize();
    for (const mask of footerMasks[index]) {
      const x = Math.max(0, mask.x);
      const y = Math.max(0, mask.y);
      const maskWidth = Math.min(mask.width, width - x);
      const maskHeight = Math.min(mask.height, height - y);
      if (maskWidth > 0 && maskHeight > 0) {
        page.drawRectangle({ x, y, width: maskWidth, height: maskHeight, color: rgb(1, 1, 1) });
      }
    }
  });
  const embedded = await output.embedPdf(statutory, statutory.getPageIndices());
  return embedded.map((embeddedPage) => {
    const placement = letterPlacement({ width: embeddedPage.width, height: embeddedPage.height });
    const letterPage = output.addPage([LETTER_PAGE.width, LETTER_PAGE.height]);
    letterPage.drawPage(embeddedPage, {
      x: placement.x,
      y: placement.y,
      xScale: placement.scale,
      yScale: placement.scale,
      rotate: degrees(placement.rotateDegrees),
    });
    return placement;
  });
}

/** Render every page of a PDF with the pinned PDF.js assets and measure each
 *  page's ink bounding box in PDF points. Rendering here is a measurement
 *  instrument only — the pixels are discarded and the embedded content stays
 *  vector. The same pinned renderer already underwrites the fingerprint stack,
 *  so the measurement is deterministic across independent builds. */
export async function measureInkBoundingBoxes(bytes, {
  scale = 2,
  threshold = INK_THRESHOLD,
  pageNumbers = null,
  excludeBottomPt = 0,
} = {}) {
  const { createCanvas, DOMMatrix, ImageData, Path2D } = await import('@napi-rs/canvas');
  globalThis.DOMMatrix ||= DOMMatrix;
  globalThis.ImageData ||= ImageData;
  globalThis.Path2D ||= Path2D;
  const [{ getDocument }, { PDFJS_NODE_ASSETS }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('./pdfjs-assets.mjs'),
  ]);
  const task = getDocument({ data: new Uint8Array(bytes), disableWorker: true, ...PDFJS_NODE_ASSETS });
  const pdf = await task.promise;
  const targets = pageNumbers ?? Array.from({ length: pdf.numPages }, (_, index) => index + 1);
  const boxes = [];
  try {
    for (const pageNumber of targets) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
        throw new Error(`ink measurement requested page ${pageNumber} outside 1..${pdf.numPages}`);
      }
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
      // Optionally ignore the bottom band (the stamped running footer) so a
      // page's ink measurement reflects its body, not the packet chrome.
      const scanHeight = Math.max(1, height - Math.round(excludeBottomPt * scale));
      const data = context.getImageData(0, 0, width, scanHeight).data;
      boxes.push(inkBoundingBoxFromPixels(data, width, scanHeight, scale, viewport.height / scale, threshold));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return boxes;
}

/** v5: load one statutory source, strip its interactive layer, mask its stale
 *  footers in SOURCE space, measure each masked page's ink bounding box, then
 *  append each page to `output` as a Letter portrait page whose embedded
 *  XObject is CROPPED to that padded box before the fit-and-center transform.
 *  Nothing splits and nothing reorders: one source page is one output page,
 *  reading order untouched. Returns per-page placements with coverage stats. */
export async function appendInkFitStatutoryPages({ output, statutoryBytes, footerMasks, expectedPageCount, label }) {
  const statutory = await PDFDocument.load(statutoryBytes, { ignoreEncryption: true, updateMetadata: false });
  statutory.catalog.delete(PDFName.of('AcroForm'));
  for (const page of statutory.getPages()) page.node.delete(PDFName.of('Annots'));
  if (statutory.catalog.get(PDFName.of('AcroForm')) ||
    statutory.getPages().some((page) => page.node.get(PDFName.of('Annots')))) {
    throw new Error(`${label}: could not remove statutory widgets before ink-fit normalization`);
  }
  const pages = statutory.getPages();
  if (pages.length !== expectedPageCount) {
    throw new Error(`${label}: statutory source page count changed during ink-fit normalization`);
  }
  if (!Array.isArray(footerMasks) || footerMasks.length !== pages.length) {
    throw new Error(`${label}: statutory footer scan does not cover every source page`);
  }
  pages.forEach((page, index) => {
    assertNormalizableSourcePage(page, `${label} page ${index + 1}`);
    const { width, height } = page.getSize();
    for (const mask of footerMasks[index]) {
      const x = Math.max(0, mask.x);
      const y = Math.max(0, mask.y);
      const maskWidth = Math.min(mask.width, width - x);
      const maskHeight = Math.min(mask.height, height - y);
      if (maskWidth > 0 && maskHeight > 0) {
        page.drawRectangle({ x, y, width: maskWidth, height: maskHeight, color: rgb(1, 1, 1) });
      }
    }
  });
  // Measure AFTER masking: a whited-out stale footer must not hold the crop
  // open, and the crop must never separate real ink from the sheet.
  const maskedBytes = await statutory.save({
    useObjectStreams: false,
    addDefaultPage: false,
    objectsPerTick: Infinity,
    updateFieldAppearances: false,
  });
  const inkBoxes = await measureInkBoundingBoxes(maskedBytes);
  const crops = pages.map((page, index) => {
    const ink = inkBoxes[index];
    if (!ink) throw new Error(`${label}: statutory page ${index + 1} rendered no ink; refusing to place a blank page`);
    const { width, height } = page.getSize();
    return { ink, crop: paddedCropBox(ink, width, height) };
  });
  // The bounding box crops the embedded XObject; pdf-lib's default matrix shifts
  // the box origin to (0,0), so the embedded page behaves as a page of exactly
  // the crop's dimensions and the v4 draw math carries over unchanged.
  const embedded = await output.embedPages(pages, crops.map(({ crop }) => crop));
  return embedded.map((embeddedPage, index) => {
    const { ink, crop } = crops[index];
    const page = pages[index];
    const placement = inkFitPlacement(page.getSize(), crop);
    const letterPage = output.addPage([LETTER_PAGE.width, LETTER_PAGE.height]);
    letterPage.drawPage(embeddedPage, {
      x: placement.x,
      y: placement.y,
      xScale: placement.scale,
      yScale: placement.scale,
      rotate: degrees(placement.rotateDegrees),
    });
    const landscape = placement.rotateDegrees === 90;
    const inkWidth = ink.right - ink.left;
    const inkHeight = ink.top - ink.bottom;
    const placedInkWidth = (landscape ? inkHeight : inkWidth) * placement.scale;
    const placedInkHeight = (landscape ? inkWidth : inkHeight) * placement.scale;
    const contentBoxWidth = LETTER_PAGE.width - 2 * 28;
    const contentBoxHeight = LETTER_PAGE.height - 2 * 28;
    return {
      ...placement,
      ink,
      crop,
      coverage: {
        placedInkWidth: Number(placedInkWidth.toFixed(2)),
        placedInkHeight: Number(placedInkHeight.toFixed(2)),
        pctContentBoxWidth: Number((100 * placedInkWidth / contentBoxWidth).toFixed(1)),
        pctContentBoxHeight: Number((100 * placedInkHeight / contentBoxHeight).toFixed(1)),
      },
    };
  });
}
