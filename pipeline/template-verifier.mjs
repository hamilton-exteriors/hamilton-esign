import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE } from './build-docs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDFJS_ROOT = join(HERE, '..', 'node_modules', 'pdfjs-dist');
const directoryPath = (value) => `${value.replaceAll('\\', '/').replace(/\/$/, '')}/`;

export const PDFJS_NODE_ASSETS = Object.freeze({
  standardFontDataUrl: directoryPath(join(PDFJS_ROOT, 'standard_fonts')),
  wasmUrl: directoryPath(join(PDFJS_ROOT, 'wasm')),
  useSystemFonts: false,
  isImageDecoderSupported: false,
});

export const BODY_BAND = Object.freeze({
  topRatio: PAGE.mt / PAGE.h,
  bottomRatio: 1 - (PAGE.mb / PAGE.h),
});

export const EXPECTED_BODY_BOUNDS = Object.freeze({
  leftRatio: PAGE.ml / PAGE.w,
  rightRatio: 1 - (PAGE.mr / PAGE.w),
  toleranceRatio: 0.03,
});

export function inkBox(context, width, height, { top = 0, bottom = height } = {}) {
  const data = context.getImageData(0, 0, width, height).data;
  const startY = Math.max(0, Math.floor(top));
  const endY = Math.min(height, Math.ceil(bottom));
  let minX = width;
  let maxX = 0;
  let ink = 0;
  for (let y = startY; y < endY; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4;
      if (data[index] < 200 || data[index + 1] < 200 || data[index + 2] < 200) {
        ink += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { width, height, minX, maxX, ink };
}

export function inspectInkBands(context, width, height) {
  return {
    full: inkBox(context, width, height),
    body: inkBox(context, width, height, {
      top: height * BODY_BAND.topRatio,
      bottom: height * BODY_BAND.bottomRatio,
    }),
  };
}

export function validateFirstPageBodyInk(result) {
  if (!result?.body?.ink) throw new Error('first page has no body ink');
  const minRatio = result.body.minX / result.body.width;
  const maxRatio = result.body.maxX / result.body.width;
  const expectedLeft = EXPECTED_BODY_BOUNDS.leftRatio;
  const expectedRight = EXPECTED_BODY_BOUNDS.rightRatio;
  const tolerance = EXPECTED_BODY_BOUNDS.toleranceRatio;
  if (Math.abs(minRatio - expectedLeft) > tolerance || Math.abs(maxRatio - expectedRight) > tolerance) {
    throw new Error(
      `first-page body ink bounds ${(minRatio * 100).toFixed(0)}%-${(maxRatio * 100).toFixed(0)}% do not match expected ` +
      `${(expectedLeft * 100).toFixed(0)}%-${(expectedRight * 100).toFixed(0)}%`,
    );
  }
  return { minRatio, maxRatio };
}

export function parseVerifierArgs(argv) {
  let scope = 'current';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--scope') {
      const next = argv[index + 1];
      if (!next) throw new Error('--scope requires current, w2-release, or all-live');
      scope = next;
      index += 1;
    } else if (value.startsWith('--scope=')) {
      scope = value.slice('--scope='.length);
    } else {
      throw new Error('usage: node pipeline/verify-templates.mjs [--scope current|w2-release|all-live]');
    }
  }
  if (!['current', 'w2-release', 'all-live'].includes(scope)) {
    throw new Error('--scope must be current, w2-release, or all-live');
  }
  return { scope };
}

const W2_RELEASE_SLUGS = new Set([
  'w2-initial-packet-v2',
  'w2-initial-packet-es-v2',
  'safety-training-roster',
  'safety-training-roster-es',
]);

export function validateActiveInventory(active, allowedEntries, sourceOnlyEntries) {
  const sourceOnlyTitles = new Set(sourceOnlyEntries.map((entry) => entry.title));
  const activeSourceOnly = active.filter((template) => sourceOnlyTitles.has(template.name));
  if (activeSourceOnly.length) {
    throw new Error(`source-only templates must not be active: ${activeSourceOnly.map((template) => template.name).join('; ')}`);
  }
  const expectedTitles = new Set(allowedEntries.map((entry) => entry.title));
  const unexpected = active.filter((template) => !expectedTitles.has(template.name));
  if (unexpected.length) {
    throw new Error(`unexpected active templates: ${unexpected.map((template) => template.name).join('; ')}`);
  }
}

export function liveExpectation(entry) {
  return {
    fields: entry.liveFields ?? entry.fields,
    owners: entry.liveOwners ?? entry.owners,
  };
}

export function entriesForScope({ current, retainedLegacy }, scope) {
  if (scope === 'w2-release') return current.filter((entry) => W2_RELEASE_SLUGS.has(entry.slug));
  if (scope === 'all-live') return [...current, ...retainedLegacy];
  return current;
}
