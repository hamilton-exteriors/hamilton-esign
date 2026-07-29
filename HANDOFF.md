# Handoff — Hamilton e-Sign, 2026-07-27/29

For the next agent. Written to be reviewed and continued, not admired. Where I am
unsure I say so. Where I broke something, I say that too.

**Repo:** `hamilton-exteriors/hamilton-esign` (PUBLIC, AGPL-3.0)
**Baseline before remediation:** `c922c07`
**Current signer release:** `f14e3ed` on `origin/master`; Railway deployment
`0be07a92-8d07-470a-b696-f0af74822a16` succeeded on 2026-07-29.
**Live:** <https://sign.hamilton-exteriors.com> and
<https://docuseal-production-7617.up.railway.app>, same service, both 200.
**Railway:** project `backoffice` `9ff3cd8c-…`, env `72326ee3-…`, service
`docuseal` `8f374fa6-…`

---

## 1. Read before touching anything

| Fact | Why it bites |
|---|---|
| **`git push` does NOT deploy.** The service is not wired to GitHub. | Deploy with `railway up --service docuseal --detach`, then poll the deployment id. Pushing and assuming is how you ship nothing. |
| **Rebuilding templates invalidates every signing link already sent.** | I did it three times and had to email the owner replacements each time. Use `pipeline/stamp-reflow.mjs` where possible. |
| **DocuSeal is PINNED to 3.1.5 and we ship a PATCHED Vue bundle.** | An upgrade is a project, not a bump. See §5. |
| **Never print secrets.** | I leaked `GODADDY_API_KEY`, `GODADDY_API_SECRET`, `CF_API_TOKEN`, `CF_ZONE_ID`, `CF_ACCOUNT_ID` via a bad regex whose error message echoed `~/.bashrc`. Owner has since rotated them. Read credentials line by line, validate shape before use, never interpolate into anything loggable. Pattern: `pipeline/safe.mjs`. |
| **Legal entity is `ABR Quality Resources Inc dba Hamilton Exteriors`.** Never "LLC". | Hook-enforced (`guard-legal-entity.mjs`). |
| **Owner is Alex Li, President.** Not "Alex Gutierrez". | The wrong name has re-entered memory repeatedly and once reached a real admin account. |
| **Work in a worktree**, never the primary checkout on master. | `guard-main-edit.mjs` blocks it. It blocked me writing this file. |

---

## 2. What the system does

Markdown → print HTML → Letter PDF + measured field coordinates → DocuSeal
template → per-hire signing link over WhatsApp → signed PDF back to the worker
(Labor Code §432) → filed to Google Drive.

Source documents live **outside this repo**, in
`~/.claude/skills/onboard-worker/references/documents/*.md` (15 files). The repo
holds the pipeline, the branding overlays, and the generated reading views.

```
node pipeline/build-docs.mjs <slug…>   # md → print HTML + reflow HTML; emits manifest.json
node pipeline/measure.mjs              # paginate, refine types, measure coords, emit PDF + fields.json
node pipeline/build-templates.mjs      # create templates; stages brand/reflow/ + index.json
node pipeline/verify-templates.mjs     # last-mile check against DocuSeal's own raster
node pipeline/migrate-generated-templates.mjs          # dry-run guarded in-place refresh
node pipeline/migrate-generated-templates.mjs --apply  # preserve template/field UUIDs
```

`build-docs` takes slugs as arguments and everything downstream reads only what
it produced, so a rebuild can be scoped to one document.

---

## 3. Live state, verified at handoff

**14 templates, ids 351–364.** Rebuilding renumbers them. **Resolve by name.**

```
351 Independent Contractor Agreement 12f   358 Safety Training Roster        65f
352 Employment Agreement              9f   359 Registro de Capacitación      65f
353 Contrato de Empleo                9f   360 IIPP                           5f
354 Wage Notice - Labor Code 2810.5  19f   361 Heat Illness Prevention Plan   4f
355 Aviso de Salario                 18f   362 Plan de Prevención (ES)        4f
356 New Hire Policy Acknowledgment   33f   363 Fall Protection Program        3f
357 Acuse de Recibo de Políticas     33f   364 Code of Safe Practices         2f
```

**5 open safety-program submissions await the owner's signature.** The links sent
before the final signer repair are unavailable and expose zero fields. Five fresh
submissions were created after the production walkthrough, then each was verified
in a headed mobile browser for HTTP 200, exact field and readable-anchor parity,
no overflow, and no console errors. The Spanish plan was verified using its localized
`Vista legible` control. The IIPP additionally passed ordinary-text administrative
phone semantics, corrected signer copy, and legal H1/H2 hierarchy. The exact prior
email was resent on 2026-07-29 with only the five URLs replaced (Gmail message
`19faffb39a8da760`). Bearer links are intentionally absent from Git and this handoff.
Never put signing slugs or bearer URLs in a tracked handoff.

**Field ownership per document — diff after ANY layout change.** A layout change
silently moved 4 trainer dates to the worker once (§6.2).

```
independent-contractor-agreement 10/2    policy-acknowledgment(-es)  30/3
employment-agreement(-es)         5/4    safety-training-roster(-es) 54/11
wage-notice-2810-5                5/14   iipp 0/5 · heat 0/4 (x2) · fall 0/3 · cosp 0/2
wage-notice-2810-5-es             5/13
```

---

## 3.1 Final signer repair and walkthrough, 2026-07-29

Commits `3e4c9bf`, `5c64773`, and `f14e3ed` fixed the remaining real-user defects:
IIPP Administrator phone is ordinary text with phone-sized presentation, downloads
recover cleanly from failures, sticky mobile chrome no longer intercepts fields,
fixed trays preserve bottom clearance, rapid typed/drawn signature switching no
longer hits the upstream async font null-reference race, legal H1s remain above H2s,
and signer copy no longer exposes an internal Markdown filename.

The pinned Docker build applied all 14 asserted upstream edits. The final suite passed
52/52 tests, all 14 templates verified, the scoped IIPP migration reported `current`,
and the deterministic Impeccable detector returned zero findings. Independent baseline
and adversarial assessments improved the public signer experience from 26/40 to 40/40
with no unresolved P0-P3 findings. Production checks covered 320, 375, 390, 414, and
767 px portrait, landscape, 1280 px desktop, English/Spanish, root/error/archived/
decline/duplicate/completed states, 200% text, keyboard behavior, and a full disposable
signing and six-page executed-PDF download. All disposable submissions were archived
and verified unusable.

---

## 4. What changed and why — 17 commits, `510adea..c922c07`

```
deff943 harden pipeline           4248550 make PDF match the measured DOM
ea1efa5 polish signer surfaces    ee4e42d keep bare Date with its owner
5531567 decline modal copy        beb7a7f real document, not phone screenshot
6b54695 fix ERB comment leak      20ef762 phone type + heading breaks
c932ac5 mint links on custom dom  9c7a96c split tables to fill the page
be9f861 overseas packet           e487ca7 reflowed reading view
55ac4ba contractor terms          2f000c6 / 3c2e599 inline-field plumbing
                                  fca5d9a inline fields shipped
                                  c922c07 recolor inline markers
```

**Hardening (`deff943`).** `pipeline/safe.mjs`: `loadRw`, `safeName`,
`driveQuote`, `getJson`. Worst bug was a wrong **answer**, not a crash:
`countersignLink(<bad id>)` returned *"this document has no countersigner"*,
which would let someone conclude a document needs none. `safeName` deliberately
**preserves** accents, apostrophes, emoji and CJK and only fixes genuinely broken
filenames (`"///"`, `"CON"`, `".."`).

**Polish (`ea1efa5`).** The decline confirm rendered byte-identical to the
primary NEXT button while both were on screen ~40px apart. The rule meant to
prevent it targeted `dialog .btn`; the element is `<button class="base-button">`.
Third time CSS here was written against assumed markup. Tap targets are fixed
with a `::after` hit area, never by resizing the box (resizing ate an 8px gutter).

**Decline copy (`5531567`, `6b54695`).** The modal is server-rendered ERB, not
Vue, so it is a one-partial overlay. Copy now states the consequence, localised
via `I18n.locale`, with a labelled way back **below** the destructive action.
`6b54695` fixes a bug I shipped: an ERB comment containing a closing delimiter
ends early, so *"…is a syntax error and takes the whole page to a 500."* rendered
at the top of the modal in both languages.

**Custom domain (`c932ac5`).** Two independent faults. Cert stuck in
`VALIDATING_OWNERSHIP` → `mutation{customDomainIssueCertificate(id:"c423a3e4-…")}`.
**Look for that before ever deleting a domain**; deleting mints a new CNAME
target. Then still 404 with `x-railway-fallback: true`: **a Railway custom domain
needs a TXT ownership record and Railway's `dnsRecords` query does not list it.**
The token is on `status { verified verificationDnsHost verificationToken }`.
Worker-facing host and API host are deliberately separate (`publicUrl` vs
`SEC.url`) — do not collapse them.

**Overseas packet (`be9f861`, `55ac4ba`).** I reported it "not drafted". **Wrong.**
The full set was in Drive under **"Fatmih Makburi"** — searching "Fatima" finds
nothing. Five of six "blocking decisions" were already settled in the agreement
she signed. Commercial terms are prefilled on the contractor's **own page and
locked** via `readonly_fields`, not made employer-owned, which would show a blank
rate and fill it in after signing.

**PDF geometry (`4248550`, `beb7a7f`, `20ef762`, `9c7a96c`).**
`@page { size: Letter }` while `PAGE` was 420×748 → Chromium laid out for an
816px sheet and `page.pdf()` scaled it onto 420px, so content occupied **43% of
the width** while coordinates came from the unscaled DOM. Every field sat high
and left, on live templates, undetected. Fixed with `@page` derived from `PAGE`
in **pt** (px is not honoured) plus `preferCSSPageSize: true`. Then the page
itself was wrong (4.38×7.79in, IIPP was 12 pages) → US Letter, contractor type
scale, letterhead, running footer. IIPP is 6 pages. Phone fields are DocuSeal
`phone` type plus a nonce'd formatter in the layout (capture phase, so Vue reads
the formatted value without a second event).

---

## 5. The DocuSeal fork — review this first

**We ship a recompiled DocuSeal front end.** Highest-risk thing in the repo.

- `patches/docuseal-inline-fields.mjs` — 14 asserted edits across the pinned public signer components.
- `Dockerfile` gained a `webpack` stage mirroring upstream's own: clone 3.1.5,
  apply patch, `yarn install`, `./bin/shakapacker`, then
  `COPY --from=webpack /src/public/packs /app/public/packs`.
- The runtime image ships the Vue source but **no `package.json` and no node**,
  so in-place recompilation is impossible. Hence multi-stage.
- **Reproducibility proven first:** a NO-OP recompile of 3.1.5 produced packs
  with the *same content hashes* as production, so a patched build differs only
  by the patch. Re-run that if you ever doubt the build.

**Mechanism.** `areas.vue` teleports field components into server-rendered
`page-<attachment_uuid>-<n>` elements. The patch makes it prefer an element
carrying `data-hx-uuid="<field uuid>"` when one is visible. `area.vue` gains an
`inline` prop swapping page-percentage geometry for filling its anchor.

**Reading view.** `brand/reflow/*.reflow.html`, served from `/reflow/`, generated
by `build-docs`, scoped under `#hx-read-doc` at build time, injected by a nonce'd
script in `brand/form.html.erb` below 768px. It is a **fragment, not an iframe** —
Teleport cannot cross documents.

**Ordering trap, handled.** The view arrives from an async fetch and can land
after components have mounted and chosen page images. Injecting DOM is not a
reactive change, so the patch listens for `hx-reflow-ready` and `$forceUpdate()`s.

**`pipeline/stamp-reflow.mjs`** publishes each freshly generated
`build/<slug>.reflow.html` into `brand/reflow/` and stamps **live** field UUIDs
without rebuilding templates. Run `build-docs` first. It matches each generated
field to the live field by normalised page, geometry, type, and signer role.
Array order is never an identity; missing build output, duplicate, stale, or
ambiguous matches fail closed.

Verified live at handoff:
```
phone    anchors=5 fieldsInline=5 fieldsOnPages=0 pagesHidden=true  steps=5
desktop  anchors=0 fieldsInline=0 fieldsOnPages=5 pagesHidden=false steps=5
```

---

## 6. Mistakes I made — verify I actually fixed them

1. **ERB comment leaked into the decline modal**, both languages, live. **15 live
   assertions passed** because every one checked that the right text was present
   and none checked that no wrong text was.
2. **A layout change silently moved field ownership.** Splitting
   `Trainer: ___  Date: ___` onto separate lines moved 4 trainer dates per roster
   to the Worker — a trainee certifying his own training dates. Caught only by
   watching owner counts (54/11 → 58/7).
3. **Killed the owner's signing links three times** by rebuilding templates.
4. **Leaked five credentials** (§1).
5. **A miscalibrated check I wrote then deleted**: parsing the PDF content stream
   reported 417% on a provably correct build because it read Form XObject space.
   Rasterise and count pixels instead (`verify-templates.mjs`).
6. **`verify-templates` had a hardcoded 70% threshold** from the old page size and
   failed all 14 the moment the page became Letter. It derives from `PAGE` now.
7. **A CSS scoper that skipped selectors following a comment**, leaving `.ds`,
   `.legal`, `.letterhead` free to restyle DocuSeal's UI. My first check reported
   "unscoped selectors: none" because it shared the scoper's blind spot.
8. **Inline fields shipped rendering red** (DocuSeal stock), because the green
   recolor is scoped to `page-container` and they now live in `#hx-read-doc`.
   Fixed in `c922c07`.

---

## 7. Verification

```bash
bun run test                              # unit + responsive controller regressions
node pipeline/build-docs.mjs
node pipeline/measure.mjs
node pipeline/stamp-reflow.mjs            # read-only live UUID mapping report
node pipeline/verify-templates.mjs        # all 14 templates, every PDF page
# ERB — a bad layout 500s every signer page. The harness MUST wrap the compiled
# template in a method, or a layout that legitimately yields reports "Invalid yield":
docker run --rm -v "<dir>:/chk:ro" -v "<erbcheck2.rb>:/e.rb:ro" -w /app \
  hamilton-esign-review bundle exec ruby /e.rb
```

⚠️ **Verify document TEXT against `build/<slug>.html`, never the signer page.**
DocuSeal rasterises the document, so `innerText` contains no contract text and
assertions there pass off the footer chrome instead.

---

## 8. Release status and remaining work

**Release status:** live and post-deploy verified on 2026-07-29 at `f14e3ed` /
Railway `0be07a92-8d07-470a-b696-f0af74822a16`. Both production hosts returned
200. Git push alone still does not deploy this service.

**Blocked on the owner, not code:**
1. **Sign the 5 safety programs.** The final verified private links were emailed on
   2026-07-29. Every previously emailed link is unavailable and exposes zero fields.
   The Policy Acknowledgment stays gated.
2. **Workers comp class 5552.** Section 6 of the wage notice remains blank until
   bound, and nobody goes on a roof until it is.

**Deliberately deferred:**
- Webhook-driven packet advancement and scheduled Drive filing need a durable
  datastore, endpoint, retention policy, and operator.
- The durable operational source for trainer confirmation is not selected. Until
  then the roster requires the explicit `training` command and recorded trainer name.
- The overseas agreement has no Spanish variant; do not machine-translate it.

**Closed by this remediation:**
- Complex 65-field roster and 33-field acknowledgment responsive behavior is covered.
- Mobile page/readable toggles, both viewport crossings, and stale UUID fallback have
  browser regressions using the real layout controller.
- Preview/plan is read-only; template lookup and pagination fail closed.
- Worker type is mandatory; training is outside automatic new-hire progression.
- Packet state uses generated IDs, atomic checkpoints, recoverable locks, explicit
  ambiguous-delivery retry, and per-artifact retry state.
- Drive deduplication uses immutable submission/document `appProperties`.
- Full verification requires all 14 templates and rasterizes every PDF page.
- Docker bases, DocuSeal source, APK packages, Shakapacker, and Yarn lock resolution
  are pinned.

**Post-deploy verification completed:**
- Final disposable walkthrough covered every public signer state and the responsive
  matrix listed in §3.1 with no unresolved P0-P3 findings.
- Release gates passed 52/52 tests, the 14-template verifier, scoped IIPP dry run,
  deterministic Impeccable scan, and the pinned Docker build with 14 asserted edits.
- One synthetic IIPP completed end to end without phone OTP; its six-page executed
  PDF downloaded and contained the entered administrative phone.
- Required validation, Today dates, typed signature, decline/Escape, duplicate tabs,
  pending/completed downloads, archived routes, and rapid Type/Draw switching passed.
- All disposable submissions were archived and API-verified unusable.
- The final five private links were independently headed-browser verified before email.
  Every previously emailed route remains unavailable with zero fields.

---

## 9. Where things live

```
hamilton-esign/
  Dockerfile                  multi-stage: webpack (patched Vue) → docuseal 3.1.5 + overlays
  patches/docuseal-inline-fields.mjs    14 asserted signer-component edits
  brand/                      hamilton.css, form.html.erb, _decline_form.html.erb, icons, fonts
  brand/reflow/               generated reading views + index.json (template name → slug)
  pipeline/                   build-docs, measure, build-templates, verify-templates,
                              stamp-reflow, send-signing-link, send-pamphlets, send-programs,
                              run-packet, worker-types, file-to-drive, safe
~/.claude/skills/onboard-worker/references/documents/*.md   SOURCE OF TRUTH for content
~/.claude/.hamilton-secrets/docuseal.json                   url, publicUrl, email, password, apiKey
```

Memory to read first: `project_esign_docuseal_build.md`,
`reference_worker_packet_types.md`, `reference_hamilton_legal_entity_name.md`.
