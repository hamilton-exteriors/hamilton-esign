import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fingerprintPdf, fingerprintsEqual } from '../pipeline/pdf-fingerprint.mjs';
import { sha256 } from '../pipeline/build-manifest.mjs';

async function samplePdf(text, { producer = 'local', objectStreams = false, mark = false } = {}) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setProducer(producer);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 200]);
  page.drawText(text, { x: 30, y: 140, size: 16, font, color: rgb(0, 0, 0) });
  if (mark) page.drawRectangle({ x: 30, y: 80, width: 50, height: 20, color: rgb(1, 0, 0) });
  return Buffer.from(await pdf.save({
    useObjectStreams: objectStreams,
    addDefaultPage: false,
    objectsPerTick: Infinity,
    updateFieldAppearances: false,
  }));
}

test('diagnostic PDF fingerprint can identify semantic, visual, and operator equality across raw drift', async () => {
  const original = await samplePdf('Same employment terms', { producer: 'local', objectStreams: false });
  const reserialized = await PDFDocument.load(original, { updateMetadata: false });
  reserialized.setProducer('provider normalized');
  const provider = Buffer.from(await reserialized.save({
    useObjectStreams: true,
    addDefaultPage: false,
    objectsPerTick: Infinity,
    updateFieldAppearances: false,
  }));
  assert.notEqual(sha256(original), sha256(provider));
  const localFingerprint = await fingerprintPdf(original);
  const providerFingerprint = await fingerprintPdf(provider);
  assert.equal(fingerprintsEqual(localFingerprint, providerFingerprint), true);
  assert.equal(localFingerprint.semanticSha256, providerFingerprint.semanticSha256);
  assert.equal(localFingerprint.visualSha256, providerFingerprint.visualSha256);
});

test('diagnostic PDF fingerprint detects changed text and changed rendered marks', async () => {
  const original = await fingerprintPdf(await samplePdf('Greater of piece rate or guarantee'));
  const alteredText = await fingerprintPdf(await samplePdf('Piece rate plus guarantee'));
  const alteredDrawing = await fingerprintPdf(await samplePdf('Greater of piece rate or guarantee', { mark: true }));
  assert.equal(fingerprintsEqual(original, alteredText), false);
  assert.notEqual(original.semanticSha256, alteredText.semanticSha256);
  assert.equal(fingerprintsEqual(original, alteredDrawing), false);
  assert.equal(original.semanticSha256, alteredDrawing.semanticSha256);
  assert.notEqual(original.visualSha256, alteredDrawing.visualSha256);
});
