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
import { PDFDocument, PDFName, degrees, rgb } from 'pdf-lib';

export const LETTER_PAGE = Object.freeze({ width: 612, height: 792 });

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
