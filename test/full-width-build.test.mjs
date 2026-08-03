// Build-artifact assertions for the v5 full-width generation. These run
// against build/fields.json + build/letter-coverage.json when a local build
// exists and skip (visibly) otherwise, so a fresh clone's unit suite stays
// green while a built tree cannot ship a regression in:
//   - reproducibility: the retained v3/v4 and current v5 builds must produce
//     the exact layout digests their committed provider attestations pin;
//   - v5 identity: field/ownership totals and registry page counts;
//   - v5 page fill: every statutory page over the 60% no-split floor and every
//     full-text authored page at >= 80% of the sheet width.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { BUILD_DIR } from '../pipeline/config.mjs';
import { TEMPLATE_BY_SLUG } from '../pipeline/registry.mjs';

const fieldsPath = `${BUILD_DIR}/fields.json`;
const coveragePath = `${BUILD_DIR}/letter-coverage.json`;
const hasBuild = existsSync(fieldsPath) && existsSync(coveragePath);
const measuredBySlug = hasBuild
  ? new Map(JSON.parse(readFileSync(fieldsPath, 'utf8')).map((document) => [document.slug, document]))
  : new Map();
const coverageBySlug = hasBuild ? JSON.parse(readFileSync(coveragePath, 'utf8')) : {};

const liveAttestation = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations.json', import.meta.url), 'utf8'));
const retainedV3Attestation = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations-v3.json', import.meta.url), 'utf8'));
const retainedV2Attestation = JSON.parse(readFileSync(
  new URL('../brand/reflow/provider-attestations-v2.json', import.meta.url), 'utf8'));
const attested = (attestation, slug) => attestation.entries.find((entry) => entry.slug === slug) || null;

test('retained v3/v4 and current v5 builds reproduce their attested layout digests', (t) => {
  if (!hasBuild) return t.skip('no local build; run build-docs + measure first');
  for (const [slug, attestation] of [
    ['w2-initial-packet-v3', retainedV2Attestation],
    ['w2-initial-packet-es-v3', retainedV2Attestation],
    ['w2-initial-packet-v4', retainedV3Attestation],
    ['w2-initial-packet-es-v4', retainedV3Attestation],
    ['w2-initial-packet-v5', liveAttestation],
    ['w2-initial-packet-es-v5', liveAttestation],
  ]) {
    const measured = measuredBySlug.get(slug);
    assert.ok(measured, `${slug}: build output is missing from fields.json`);
    const entry = attested(attestation, slug);
    assert.ok(entry, `${slug}: committed attestation entry is missing`);
    assert.equal(measured.layoutSha256, entry.layoutSha256,
      `${slug}: rebuilt layout digest no longer matches its committed provider attestation`);
  }
});

test('v5 packets keep the pinned identity and registry page counts', (t) => {
  if (!hasBuild) return t.skip('no local build; run build-docs + measure first');
  for (const [slug, owners] of [
    ['w2-initial-packet-v5', { worker: 41, employer: 21 }],
    ['w2-initial-packet-es-v5', { worker: 41, employer: 20 }],
  ]) {
    const measured = measuredBySlug.get(slug);
    assert.ok(measured, `${slug}: v5 build output is missing from fields.json`);
    const registry = TEMPLATE_BY_SLUG.get(slug);
    assert.equal(measured.pageCount, registry.pageCount, `${slug}: page count`);
    assert.equal(measured.fields.length, registry.fields, `${slug}: field count`);
    const counts = measured.fields.reduce((totals, field) => {
      totals[field.owner] = (totals[field.owner] || 0) + 1;
      return totals;
    }, {});
    assert.deepEqual(counts, owners, `${slug}: field ownership totals`);
  }
});

test('v5 page-fill coverage clears the statutory and authored floors on every page', (t) => {
  if (!hasBuild) return t.skip('no local build; run build-docs + measure first');
  for (const slug of ['w2-initial-packet-v5', 'w2-initial-packet-es-v5']) {
    const coverage = coverageBySlug[slug];
    const measured = measuredBySlug.get(slug);
    assert.ok(Array.isArray(coverage) && coverage.length, `${slug}: coverage report is missing`);
    assert.equal(coverage.length, measured.pageCount, `${slug}: coverage must include every page`);
    assert.deepEqual(coverage.map((page) => page.page), coverage.map((_, index) => index + 1),
      `${slug}: coverage pages must be contiguous`);
    for (const page of coverage) {
      if (page.kind === 'statutory') {
        assert.ok(page.pctContentBoxWidth >= 60,
          `${slug} p${page.page} (${page.sourceSlug}): statutory ${page.pctContentBoxWidth}% below the 60% floor`);
      } else if (page.fullText) {
        assert.ok(page.placedInkWidth >= 0.80 * 612,
          `${slug} p${page.page} (${page.sourceSlug}): full-text authored page at ${page.pctPageWidth}% of sheet width`);
      }
    }
    const statutoryPages = coverage.filter((page) => page.kind === 'statutory').length;
    const generatedPages = coverage.filter((page) => page.kind === 'generated').length;
    assert.equal(statutoryPages + generatedPages, measured.pageCount, `${slug}: page classification`);
  }
});
