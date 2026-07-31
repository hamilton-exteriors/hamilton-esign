import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATUTORY_DIR, STATUTORY_LOCK_PATH } from './config.mjs';
import {
  fetchStatutoryPdf,
  loadStatutoryLock,
  statutorySources,
} from './statutory-assets.mjs';

const apply = process.argv.slice(2).includes('--apply');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(', ')}`);

const lock = loadStatutoryLock(STATUTORY_LOCK_PATH);
const sources = new Map();
for (const language of ['en', 'es']) {
  for (const source of statutorySources(language)) sources.set(source.slug, source);
}
if (sources.size !== lock.size || [...sources.keys()].some((slug) => !lock.has(slug))) {
  throw new Error('registry statutory sources and immutable lock do not have exact coverage');
}

const scratch = mkdtempSync(join(tmpdir(), 'hamilton-statutory-refresh-'));
try {
  for (const source of sources.values()) {
    const expected = lock.get(source.slug);
    await fetchStatutoryPdf(source, scratch, expected);
    console.log(`verified ${source.slug} ${expected.sha256}`);
  }
  if (!apply) {
    console.log(`\ndry-run only: ${sources.size} authoritative assets match the immutable lock; rerun with --apply to restore the checked cache`);
  } else {
    // All network reads and digests succeeded before the first repository write.
    for (const source of sources.values()) {
      const expected = lock.get(source.slug);
      const bytes = readFileSync(join(scratch, 'statutory', `${source.slug}.pdf`));
      cpSync(join(scratch, 'statutory', `${source.slug}.pdf`), join(STATUTORY_DIR, expected.filename));
      if (bytes.length !== expected.bytes) throw new Error(`${source.slug}: staged byte count changed before copy`);
    }
    console.log(`\nrestored ${sources.size} pinned statutory assets from verified authoritative bytes`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
