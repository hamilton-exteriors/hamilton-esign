// Shared hardening helpers. Every one of these exists because a probe found the
// unhardened version producing a wrong answer or an unreadable crash, not
// because it seemed prudent.
import { readFileSync, existsSync } from 'node:fs';

/** Load the WhatsApp/platform credentials with an actionable error.
 *
 *  Unhardened, a missing file threw a raw `ENOENT ... open 'C:\nope\rw.json'`
 *  from inside sendWhatsApp, which says nothing about what the file is or where
 *  it should be. That matters more than usual here: this file currently lives in
 *  a session scratchpad, so the path really does go missing. */
export function loadRw(rwPath) {
  if (!rwPath) {
    throw new Error(
      'no credentials path given. Pass the path to rw.json, which must contain ' +
      'RAILWAY_PUBLIC_DOMAIN and PLATFORM_INTERNAL_TOKEN. Nothing is sent without it.');
  }
  if (!existsSync(rwPath)) {
    throw new Error(
      `credentials file not found at ${rwPath}. It must contain ` +
      `RAILWAY_PUBLIC_DOMAIN and PLATFORM_INTERNAL_TOKEN. It currently lives in a ` +
      `session scratchpad, so this path does go stale — find the live copy rather ` +
      `than hand-writing one.`);
  }
  let v;
  try { v = JSON.parse(readFileSync(rwPath, 'utf8')); }
  catch (e) { throw new Error(`credentials file at ${rwPath} is not valid JSON: ${e.message}`); }
  const missing = ['RAILWAY_PUBLIC_DOMAIN', 'PLATFORM_INTERNAL_TOKEN'].filter(k => !v[k]);
  if (missing.length) {
    throw new Error(`credentials file at ${rwPath} is missing: ${missing.join(', ')}`);
  }
  return v;
}

/** Filesystem- and Drive-safe fragment derived from a person's name.
 *
 *  Probed inputs that broke the naive `replace(/[\\/:*?"<>|]/g,'')`:
 *    "///"  -> ""      an empty Drive folder name and a filename of " - date.pdf"
 *    "   "  -> "   "   same, plus a folder whose name is invisible
 *    ".."   -> ".."    a dot-only path segment
 *    "CON"  -> "CON"   a reserved Windows device name
 *  Accents, apostrophes, emoji and CJK all round-trip fine and are kept: a
 *  worker's name is his name, and mangling "José" would be its own defect. */
export function safeName(raw, fallback = 'Unnamed') {
  let s = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')   // illegal on Windows/Drive
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')       // no leading/trailing dots
    .trim();
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(s)) s = `${s}_`;
  if (s.length > 60) s = s.slice(0, 60).trim();
  return s || fallback;
}

/** Escape a value for a Google Drive `q=` string literal. */
export const driveQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Fetch JSON and distinguish "not found" from "empty" from "server error".
 *
 *  Unhardened, a nonexistent submission id fell through to a truthful-looking
 *  but WRONG answer: countersignLink(99999999) returned "this document has no
 *  countersigner", which would let someone conclude a document needs no
 *  countersignature when in fact the id was bad. A missing thing and an empty
 *  thing are different facts and must not share a message. */
export async function getJson(url, headers, what = 'resource') {
  let res;
  try { res = await fetch(url, { headers }); }
  catch (e) { throw new Error(`network error reaching ${what}: ${e.message}`); }
  if (res.status === 404) throw new Error(`${what} not found (404). Check the id — it may have been archived or never existed.`);
  if (res.status === 401 || res.status === 403) throw new Error(`not authorised for ${what} (${res.status}). The API key may be wrong or revoked.`);
  if (res.status === 429) throw new Error(`rate limited fetching ${what} (429). Retry after a pause.`);
  if (res.status >= 500) throw new Error(`server error fetching ${what} (${res.status}).`);
  if (!res.ok) throw new Error(`unexpected ${res.status} fetching ${what}.`);
  try { return await res.json(); }
  catch (e) { throw new Error(`${what} did not return JSON: ${e.message}`); }
}
