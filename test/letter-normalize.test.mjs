import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  LETTER_PAGE,
  appendLetterNormalizedStatutoryPages,
  assertNormalizableSourcePage,
  letterPlacement,
} from '../pipeline/letter-normalize.mjs';
import { PDFJS_NODE_ASSETS } from '../pipeline/pdfjs-assets.mjs';

globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test('letter placement covers every real packet source geometry exactly', () => {
  // Already Letter (DWC, paid sick leave, victims rights, CRD ES): identity.
  const identity = letterPlacement({ width: 612, height: 792 });
  assert.equal(identity.rotateDegrees, 0);
  close(identity.scale, 1, 'identity scale');
  close(identity.x, 0, 'identity x');
  close(identity.y, 0, 'identity y');

  // Half-letter pamphlet (DE 2320, 396x612): the intended ~1.29x upscale,
  // full page height, centered horizontally.
  const pamphlet = letterPlacement({ width: 396, height: 612 });
  assert.equal(pamphlet.rotateDegrees, 0);
  close(pamphlet.scale, 792 / 612, 'pamphlet scale');
  close(pamphlet.bounds.height, 792, 'pamphlet placed height');
  close(pamphlet.bounds.width, 396 * (792 / 612), 'pamphlet placed width');
  close(pamphlet.bounds.left, (612 - 396 * (792 / 612)) / 2, 'pamphlet centered');
  close(pamphlet.bounds.bottom, 0, 'pamphlet bottom');

  // 11x8.5 landscape spread (DE 2511): rotates 90 and becomes exact full-bleed
  // Letter, rotation anchored at the placed box's bottom-right corner.
  const spread = letterPlacement({ width: 792, height: 612 });
  assert.equal(spread.rotateDegrees, 90);
  close(spread.scale, 1, 'spread scale');
  close(spread.x, 612, 'spread rotation anchor x');
  close(spread.y, 0, 'spread rotation anchor y');
  close(spread.bounds.width, 612, 'spread placed width');
  close(spread.bounds.height, 792, 'spread placed height');

  // 17x8.5 folded brochure (DE 2515): rotate then fit, centered horizontally.
  const brochure = letterPlacement({ width: 1224, height: 612 });
  assert.equal(brochure.rotateDegrees, 90);
  close(brochure.scale, 792 / 1224, 'brochure scale');
  close(brochure.bounds.width, 612 * (792 / 1224), 'brochure placed width');
  close(brochure.bounds.height, 792, 'brochure placed height');
  close(brochure.bounds.left, (612 - 612 * (792 / 1224)) / 2, 'brochure centered');
  close(brochure.x, brochure.bounds.left + brochure.bounds.width, 'brochure anchor x');
  close(brochure.y, 0, 'brochure anchor y');

  // 11x17 CRD poster (792x1224) is PORTRAIT: fit only, never rotated.
  const poster = letterPlacement({ width: 792, height: 1224 });
  assert.equal(poster.rotateDegrees, 0);
  close(poster.scale, 792 / 1224, 'poster scale');
  close(poster.bounds.height, 792, 'poster placed height');
  close(poster.bounds.left, (612 - 792 * (792 / 1224)) / 2, 'poster centered');

  // A square page counts as portrait: centered fit, no rotation.
  const square = letterPlacement({ width: 100, height: 100 });
  assert.equal(square.rotateDegrees, 0);
  close(square.scale, 6.12, 'square scale');
  close(square.bounds.bottom, (792 - 612) / 2, 'square centered vertically');

  for (const bad of [{ width: 0, height: 10 }, { width: 10, height: -1 }, { width: NaN, height: 10 }, null]) {
    assert.throws(() => letterPlacement(bad), /positive finite/);
  }
});

test('normalization fails closed on rotated, offset, or cropped source pages', async () => {
  const rotated = await PDFDocument.create();
  rotated.addPage([612, 792]).setRotation(degrees(90));
  assert.throws(() => assertNormalizableSourcePage(rotated.getPage(0), 'rotated'), /\/Rotate 90/);

  const offset = await PDFDocument.create();
  const offsetPage = offset.addPage([612, 792]);
  offsetPage.setMediaBox(10, 0, 612, 792);
  assert.throws(() => assertNormalizableSourcePage(offsetPage, 'offset'), /MediaBox origin/);

  const cropped = await PDFDocument.create();
  const croppedPage = cropped.addPage([612, 792]);
  croppedPage.setCropBox(0, 0, 500, 700);
  assert.throws(() => assertNormalizableSourcePage(croppedPage, 'cropped'), /CropBox must equal/);

  const clean = await PDFDocument.create();
  assert.doesNotThrow(() => assertNormalizableSourcePage(clean.addPage([396, 612]), 'clean'));
});

async function renderFirstPage(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), disableWorker: true, ...PDFJS_NODE_ASSETS });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
    const text = await page.getTextContent();
    page.cleanup();
    return {
      width: viewport.width,
      height: viewport.height,
      items: text.items.filter((item) => String(item.str || '').trim()),
      // Count dark pixels inside a PDF-space rectangle (pdfjs canvas is top-down).
      inkIn: (left, bottom, width, height) => {
        let ink = 0;
        const data = context.getImageData(
          Math.floor(left), Math.floor(viewport.height - bottom - height),
          Math.ceil(width), Math.ceil(height),
        ).data;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] < 200 || data[index + 1] < 200 || data[index + 2] < 200) ink += 1;
        }
        return ink;
      },
    };
  } finally {
    await task.destroy();
  }
}

test('a landscape source page rotates onto Letter with selectable text and applied masks', async () => {
  const statutory = await PDFDocument.create();
  const font = await statutory.embedFont(StandardFonts.Helvetica);
  const page = statutory.addPage([792, 612]);
  page.drawText('Landscape statutory sentence', { x: 200, y: 300, size: 14, font });
  page.drawText('stale footer artifact', { x: 30, y: 12, size: 8, font });
  const statutoryBytes = Buffer.from(await statutory.save({ useObjectStreams: false }));

  const normalize = async (footerMasks) => {
    const output = await PDFDocument.create();
    const placements = await appendLetterNormalizedStatutoryPages({
      output,
      statutoryBytes,
      footerMasks,
      expectedPageCount: 1,
      label: 'landscape-test',
    });
    return { placements, bytes: Buffer.from(await output.save({ useObjectStreams: false })) };
  };
  const { placements, bytes: outputBytes } = await normalize([[{ x: 25, y: 6, width: 160, height: 14 }]]);
  const { bytes: unmaskedBytes } = await normalize([[]]);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].rotateDegrees, 90);

  const reloaded = await PDFDocument.load(outputBytes, { updateMetadata: false });
  assert.equal(reloaded.getPageCount(), 1);
  assert.deepEqual(
    [reloaded.getPage(0).getSize().width, reloaded.getPage(0).getSize().height],
    [LETTER_PAGE.width, LETTER_PAGE.height],
  );

  const rendered = await renderFirstPage(outputBytes);
  close(rendered.width, 612, 'rendered page width');
  close(rendered.height, 792, 'rendered page height');
  const sentence = rendered.items.find((item) => item.str.includes('Landscape statutory sentence'));
  assert.ok(sentence, 'text remains extractable after normalization');
  // A 90-degree counterclockwise draw yields text matrices of the form
  // [0, s, -s, 0, e, f]: the baseline runs UP the portrait page.
  const [a, b, c, d] = sentence.transform;
  assert.ok(Math.abs(a) < 1e-6 && Math.abs(d) < 1e-6 && b > 0 && c < 0,
    `expected rotated text matrix, got ${sentence.transform}`);

  // The source-space mask must still cover the stale footer after the transform.
  // With scale 1 and a 90-degree draw anchored at (612, 0), source (u, v) maps
  // to letter space (612 - v, u): the footer strip y in [6, 20], x in [25, 185]
  // lands as the vertical band x' in [592, 606], y' in [25, 185].
  const unmaskedRender = await renderFirstPage(unmaskedBytes);
  assert.ok(unmaskedRender.inkIn(592, 25, 14, 160) > 0, 'unmasked footer must show ink in the transformed band');
  assert.equal(rendered.inkIn(592, 25, 14, 160), 0, 'masked footer band must render white');
  const stale = rendered.items.find((item) => item.str.includes('stale footer artifact'));
  assert.ok(stale, 'masking hides footer visually; the text layer is unchanged by design');
});

test('the real DE 2515 brochure normalizes to two Letter pages with its complete text', async () => {
  const statutoryBytes = readFileSync(new URL('../statutory/statutory-de-2515.pdf', import.meta.url));

  const sourceTask = getDocument({ data: new Uint8Array(statutoryBytes), disableWorker: true, ...PDFJS_NODE_ASSETS });
  const sourcePdf = await sourceTask.promise;
  const sourceText = [];
  for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber++) {
    const page = await sourcePdf.getPage(pageNumber);
    const content = await page.getTextContent();
    sourceText.push(...content.items.map((item) => String(item.str || '').trim()).filter(Boolean));
    page.cleanup();
  }
  await sourceTask.destroy();

  const output = await PDFDocument.create();
  const placements = await appendLetterNormalizedStatutoryPages({
    output,
    statutoryBytes,
    footerMasks: [[], []],
    expectedPageCount: 2,
    label: 'de-2515-test',
  });
  assert.deepEqual(placements.map((placement) => placement.rotateDegrees), [90, 90]);
  const outputBytes = Buffer.from(await output.save({ useObjectStreams: false }));

  const task = getDocument({ data: new Uint8Array(outputBytes), disableWorker: true, ...PDFJS_NODE_ASSETS });
  const pdf = await task.promise;
  const normalizedText = [];
  try {
    assert.equal(pdf.numPages, 2);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      close(viewport.width, 612, `page ${pageNumber} width`);
      close(viewport.height, 792, `page ${pageNumber} height`);
      const content = await page.getTextContent();
      normalizedText.push(...content.items.map((item) => String(item.str || '').trim()).filter(Boolean));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  assert.deepEqual(normalizedText.sort(), sourceText.sort(),
    'every extracted source text run must survive normalization');
  assert.ok(normalizedText.some((run) => /Disability Insurance/i.test(run)));
});
