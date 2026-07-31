import { PDFDocument } from 'pdf-lib';

const RELEASE_DATE = new Date('2026-07-30T00:00:00.000Z');

export function packetFooterDescriptors(totalPages) {
  if (!Number.isInteger(totalPages) || totalPages <= 0) {
    throw new Error(`packet footer page count must be a positive integer, got ${totalPages}`);
  }
  return Array.from({ length: totalPages }, (_, page) => ({
    page,
    identity: 'ABR Quality Resources Inc dba Hamilton Exteriors | CSLB 1078806',
    number: `Page ${page + 1} of ${totalPages}`,
  }));
}

/** Normalize browser-emitted PDF metadata and object serialization.
 * Chromium writes wall-clock CreationDate/ModDate values, so retaining its raw
 * output makes otherwise identical offline builds differ byte-for-byte.
 */
export async function deterministicPdfBytes(bytes, {
  title = '',
  author = 'ABR Quality Resources Inc dba Hamilton Exteriors',
  creator = 'Hamilton e-Sign deterministic document pipeline',
  producer = 'Hamilton e-Sign / pdf-lib',
} = {}) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (title) pdf.setTitle(title);
  pdf.setAuthor(author);
  pdf.setCreator(creator);
  pdf.setProducer(producer);
  pdf.setCreationDate(RELEASE_DATE);
  pdf.setModificationDate(RELEASE_DATE);
  return Buffer.from(await pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    objectsPerTick: Infinity,
    updateFieldAppearances: false,
  }));
}
