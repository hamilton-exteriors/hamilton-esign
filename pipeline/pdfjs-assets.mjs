import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDFJS_ROOT = join(HERE, '..', 'node_modules', 'pdfjs-dist');
const directoryPath = (value) => `${value.replaceAll('\\', '/').replace(/\/$/, '')}/`;

export const PDFJS_NODE_ASSETS = Object.freeze({
  standardFontDataUrl: directoryPath(join(PDFJS_ROOT, 'standard_fonts')),
  wasmUrl: directoryPath(join(PDFJS_ROOT, 'wasm')),
  useSystemFonts: false,
  isImageDecoderSupported: false,
});
