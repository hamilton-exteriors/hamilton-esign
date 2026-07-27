# Hamilton e-Sign

Employee document signing for **ABR Quality Resources Inc dba Hamilton Exteriors**.

This is a modified build of [DocuSeal](https://github.com/docusealco/docuseal),
licensed **AGPL-3.0**. Because a modified version is served over a network, the
AGPL requires the source of the modifications be offered to users of the service.
That is what this repository is, and the signer page footer links here.

## What is modified

Only the signer-facing surface. The admin UI is untouched upstream.

| File | Change |
|---|---|
| `app/views/layouts/form.html.erb` | Loads DM Sans + the Hamilton brand stylesheet last |
| `app/assets/hamilton.css` | daisyUI theme tokens remapped to the Hamilton palette |
| `app/views/shared/_logo.html.erb` | Hamilton wordmark replaces the DocuSeal mark |
| `app/views/shared/_powered_by.html.erb` | Legal entity + CSLB + AGPL source notice |
| `lib/docuseal.rb` | `PRODUCT_NAME` constant |

Palette matches `hamilton-exteriors.com` (`src/styles/global.css`): primary
`rgb(37,99,70)`, deep `rgb(13,43,29)`, cream `rgb(244,241,235)`.

## Build

    docker build -t hamilton-esign .

Deployed on Railway (project `backoffice`, service `docuseal`).

## Document pipeline (`pipeline/`)

Markdown source of truth lives in
`~/.claude/skills/onboard-worker/references/documents/`. Nothing is authored in
DocuSeal's builder — edit the markdown and re-run.

    node pipeline/build-docs.mjs        # md -> print HTML, blanks -> measurable spans
    node pipeline/measure.mjs           # paginate, type + own each field, emit PDF + coords
    node pipeline/build-templates.mjs   # create DocuSeal templates via the admin endpoints
    node pipeline/file-to-drive.mjs sweep   # file completed submissions into Drive

Why coordinates instead of DocuSeal's `{{field}}` text tags: tag auto-detection is
not available on free self-hosted (an uploaded PDF containing tags yields
`fields: null`). Fields are measured in a real browser at Letter @96dpi and
normalised, so they land exactly on the printed rules.

**Field ownership** is derived from the markdown: `**Employee**` opens the
worker's block, a standalone `ABR Quality Resources...` heading opens Hamilton's
countersignature block. Documents become two-party submissions.

**Drive routing is a legal requirement.** I-9 and anything medical must sit in
physically separate files from the personnel file:

    Hamilton Employee Records/
      Employees/<Name>/{Personnel,I-9,Medical}/
      Safety/{Programs,Training Rosters/<Name>}/

The sweep is idempotent by filename, so a re-run or duplicate event never
produces a second copy of a signed employment record.

Credentials are read from `~/.claude/.hamilton-secrets/docuseal.json` and the
Workspace service account; none are stored in this repo.

## Sending a signing link

    node pipeline/send-signing-link.mjs "<template name>" "<worker>" <phone> <en|es>
    # add --send <path to rw.json> to actually deliver over WhatsApp

**Always append `?lang=`**, which this script does for you. Without it DocuSeal
guesses from `Accept-Language` and lands on `en-GB`, so a Spanish speaker gets a
Spanish document wrapped in an English interface. On a Labor Code 2810.5 notice
that defeats the point of producing the Spanish version. The parameter is
`lang`, not `locale`, and the account locale setting does not affect the signer
page. The countersigner link stays English regardless of the worker's language.

## Delivering the signed copy back to the worker

Labor Code 432 entitles an employee to a copy of anything they sign, and
DocuSeal never emails one (no worker email is collected) and its own download
link expires 30 minutes after signing. `deliverSignedCopy()` pushes the PDF
back over WhatsApp instead, via `/internal/whatsapp/send-document`.

Gated on the whole SUBMISSION being completed, not just the worker's part —
on a two-party document the PDF only carries both signatures once Hamilton has
countersigned, and a "here is your signed copy" message attached to an
incomplete PDF would be worse than no message.

    node pipeline/send-signing-link.mjs countersign <submissionId> [--send <rw.json> <alex-phone>]
    node pipeline/send-signing-link.mjs deliver <submissionId> "<worker name>" <phone> <en|es> <rw.json>
