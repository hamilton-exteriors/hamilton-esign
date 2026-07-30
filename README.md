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

    bun install
    node pipeline/build-docs.mjs        # md -> print HTML, blanks -> measurable spans
    node pipeline/measure.mjs           # paginate, type + own each field, emit PDF + coords
    node pipeline/build-templates.mjs   # create templates; refuses active-name collisions
    node pipeline/stamp-reflow.mjs      # publish generated reflow + verify/stamp live UUIDs
    node pipeline/file-to-drive.mjs sweep   # file completed submissions into Drive

Generated artifacts default to `build/` in this repository. Override with
`HAMILTON_BUILD_DIR`; override the markdown source with `HAMILTON_DOCS_DIR`.

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
      Contractors/<Name>/{Agreements,Restricted Tax Records}/
      Safety/{Programs,Training Rosters/<Name>}/

The sweep is idempotent by DocuSeal submission and document IDs stored in Drive
`appProperties`. Filenames include those IDs, so a second legitimate document on
the same day is preserved rather than mistaken for a duplicate.

Credentials are read from `~/.claude/.hamilton-secrets/docuseal.json` and the
Workspace service account; none are stored in this repo.

## Sending a signing link

    node pipeline/send-signing-link.mjs "<template name>" "<worker>" <phone> <en|es>
    # read-only legacy preview only

All real signing-link, countersign, and completed-copy delivery runs through the
approval-gated `pipeline/onboarding.mjs` workflow below. Direct `--send` paths are
disabled so they cannot bypass copy-hash approval or lifecycle gates.

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

    node pipeline/onboarding.mjs countersign <onboardingId> [--open]
    node pipeline/onboarding.mjs advance <onboardingId> <rw.json>

The first command checks readiness without printing the private route. `--open`
launches it directly for the authorized Hamilton operator. A later `advance`
delivers the approved completed-copy caption only after every signer is complete.

## Durable onboarding workflows

Worker classification has no default. Use the record-ID onboarding engine rather
than starting a packet directly. `plan` is read-only and returns the complete copy
bundle plus its SHA-256 hash. `start` refuses unless that exact hash was approved.

    node pipeline/onboarding.mjs create <w2_local|overseas_contractor> <intake.json>
    node pipeline/onboarding.mjs plan <onboardingId>
    node pipeline/onboarding.mjs rebind-role <onboardingId> <role-key-or-name> [version]
    node pipeline/onboarding.mjs approve-copy <onboardingId> <copy-hash> <approval-reference>
    node pipeline/onboarding.mjs start <onboardingId> <rw.json>
    node pipeline/onboarding.mjs advance <onboardingId> [rw.json] [--retry-ambiguous]
    node pipeline/onboarding.mjs training <onboardingId> <training-evidence.json> <rw.json>
    node pipeline/onboarding.mjs countersign <onboardingId> [--open]
    node pipeline/onboarding.mjs record-gate <onboardingId> <gate> <evidence-reference>
    node pipeline/onboarding.mjs file <onboardingId>
    node pipeline/onboarding.mjs status <onboardingId>
    node pipeline/role-catalog.mjs list

Overseas roles are configured in
`~/.claude/skills/onboard-worker/references/overseas-role-catalog.json`. Each role
version points to an immutable artifact under `references/roles/<role-key>/` with a
pinned SHA-256. Add a new version rather than editing an approved artifact, then change
`activeVersion` for future records.

Onboarding state is versioned, keyed by a generated onboarding ID, and written
atomically under `HAMILTON_ONBOARDING_STATE_DIR`. It stores lifecycle status,
submission IDs, manual evidence references, and audit events, but rejects signing
URLs, slugs, credentials, tokens, tax-form contents, and identity-document data.
Packet recovery state is similarly scrubbed before persistence.

The W-2 path tracks I-9 human review, W-4, DE 4, pay election, emergency contact,
payroll enrollment, DE 34, actual training evidence, tax review, and WC class 5552.
It will not send the wage notice until class 5552 is bound and the live carrier/policy fields are verified populated, and it never releases roof work while class 5552 is missing.
The overseas path supports catalog-backed English roles using the shared Independent
Contractor Agreement. `pipeline/role-catalog.mjs list` validates and displays available
roles and versions. Each record is pinned to its selected versioned scope artifact, so
changing the active version affects only future records. A recorded gate cannot bypass
an unapproved, missing, changed, or digest-mismatched role scope. W-8BEN delivery,
receipt, human review, restricted tax-record filing confirmation, and payment-rail
review remain required. The workflow never creates a W-9, 1099, payroll record,
Mercury recipient, vendor bill, or payment.

`run-packet.mjs` remains a compatibility layer for existing packet records. New
work must start through `onboarding.mjs`. If a WhatsApp outcome is ambiguous,
inspect the conversation before explicitly using `--retry-ambiguous`.

## California new-hire pamphlets — send these BEFORE the acknowledgment

Section A of the policy acknowledgment has the worker initial that he received
eight specific state notices. The e-sign flow never sent them, so every one of
those initials attested to something that had not happened. Same defect class as
an acknowledgment referencing an IIPP that did not exist.

    node pipeline/send-pamphlets.mjs verify <en|es>  # check all 8 links

Delivery is sequenced inside `pipeline/onboarding.mjs`; the direct `send` command
is disabled so it cannot bypass the approved copy hash.

Every URL is fetched and confirmed `200 application/pdf` from the issuing agency
before anything is sent, and `sendPamphlets` aborts the whole batch if any link
is dead — a 404 here would recreate the false record the module exists to
prevent. Sources: DIR/DWC (Time of Hire, DWC 9783), EDD (DE 2320/2515/2511),
DLSE (paid sick leave, domestic-violence notice), CRD (sexual harassment).
DWC 9783 is published in English only and is sent as-is to Spanish speakers,
since the predesignation form must be offered either way.
