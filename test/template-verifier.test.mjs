import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import {
  PDFJS_NODE_ASSETS,
  entriesForScope,
  inspectInkBands,
  liveExpectation,
  parseVerifierArgs,
  validateActiveInventory,
  validateFirstPageBodyInk,
} from '../pipeline/template-verifier.mjs';

test('first-page verifier ignores a wide footer and rejects overflow, narrow, or shifted body ink', () => {
  const width = 816;
  const height = 1056;
  const render = (bodyX, bodyWidth) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000';
    context.fillRect(bodyX, 180, bodyWidth, 20);
    context.fillRect(54, 1010, 708, 2); // final packet footer rule, 86.8% wide
    return inspectInkBands(context, width, height);
  };

  const expected = render(144, 552);
  const fullSpan = (expected.full.maxX - expected.full.minX) / width;
  assert.ok(fullSpan > 0.86, `expected footer to make full-page span wide, got ${fullSpan}`);
  assert.doesNotThrow(() => validateFirstPageBodyInk(expected));
  assert.throws(() => validateFirstPageBodyInk(render(20, 676)), /body ink bounds/); // left overflow
  assert.throws(() => validateFirstPageBodyInk(render(144, 650)), /body ink bounds/); // right overflow
  assert.throws(() => validateFirstPageBodyInk(render(240, 300)), /body ink bounds/); // narrow
  assert.throws(() => validateFirstPageBodyInk(render(180, 552)), /body ink bounds/); // shifted
});

test('pdfjs verifier assets point at installed fonts and wasm decoders', () => {
  assert.ok(PDFJS_NODE_ASSETS.standardFontDataUrl.endsWith('/'));
  assert.ok(PDFJS_NODE_ASSETS.wasmUrl.endsWith('/'));
  assert.ok(existsSync(PDFJS_NODE_ASSETS.standardFontDataUrl));
  assert.ok(existsSync(PDFJS_NODE_ASSETS.wasmUrl));
  assert.equal(PDFJS_NODE_ASSETS.useSystemFonts, false);
  assert.equal(PDFJS_NODE_ASSETS.isImageDecoderSupported, false);
});

test('verifier scope targets the explicit four-template W-2 release', () => {
  const current = [
    { slug: 'standalone' },
    { slug: 'w2-initial-packet-v2', sources: [{ slug: 'a' }, { slug: 'b' }] },
    { slug: 'w2-initial-packet-es-v2', sources: [{ slug: 'a-es' }, { slug: 'b-es' }] },
    { slug: 'safety-training-roster' },
    { slug: 'safety-training-roster-es' },
  ];
  assert.deepEqual(parseVerifierArgs([]), { scope: 'current' });
  assert.deepEqual(parseVerifierArgs(['--scope', 'w2-release']), { scope: 'w2-release' });
  assert.deepEqual(parseVerifierArgs(['--scope=all-live']), { scope: 'all-live' });
  assert.deepEqual(
    entriesForScope({ current, retainedLegacy: [{ slug: 'legacy' }] }, 'w2-release').map((entry) => entry.slug),
    ['w2-initial-packet-v2', 'w2-initial-packet-es-v2', 'safety-training-roster', 'safety-training-roster-es'],
  );
  assert.deepEqual(
    entriesForScope({ current, retainedLegacy: [{ slug: 'legacy' }] }, 'all-live').at(-1),
    { slug: 'legacy' },
  );
  assert.throws(() => parseVerifierArgs(['--scope', 'composites']), /current, w2-release, or all-live/);
});

test('retained live templates may pin historical field expectations without changing build truth', () => {
  assert.deepEqual(
    liveExpectation({
      fields: 34,
      owners: { worker: 31, hamilton: 3 },
      liveFields: 33,
      liveOwners: { worker: 30, hamilton: 3 },
    }),
    { fields: 33, owners: { worker: 30, hamilton: 3 } },
  );
  assert.deepEqual(
    liveExpectation({ fields: 5, owners: { hamilton: 5 } }),
    { fields: 5, owners: { hamilton: 5 } },
  );
});

test('active inventory allows retained legacy but rejects source-only or unknown identities', () => {
  const allowed = [{ title: 'Current' }, { title: 'Retained Legacy' }];
  const sourceOnly = [{ title: 'Spanish Source Only' }];
  assert.doesNotThrow(() => validateActiveInventory(
    [{ name: 'Current' }, { name: 'Retained Legacy' }],
    allowed,
    sourceOnly,
  ));
  assert.throws(
    () => validateActiveInventory([{ name: 'Spanish Source Only' }], allowed, sourceOnly),
    /source-only templates must not be active/,
  );
  assert.throws(
    () => validateActiveInventory([{ name: 'Unknown' }], allowed, sourceOnly),
    /unexpected active templates/,
  );
});
