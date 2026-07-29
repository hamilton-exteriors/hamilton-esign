---
target: public signer experience
total_score: 26
p0_count: 1
p1_count: 1
timestamp: 2026-07-29T20-16-38Z
slug: brand-form-html-erb
---
# Public signer experience critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 2/4 | Phone verification and reported Download failure do not explain cause or recovery. |
| 2 | Match system / real world | 2/4 | An administrative phone blank unexpectedly behaves like identity verification. |
| 3 | User control and freedom | 3/4 | PDF/readable switching and decline escape are strong. |
| 4 | Consistency and standards | 3/4 | Header and readable surfaces are coherent; upstream field controls diverge. |
| 5 | Error prevention | 2/4 | The wrong DocuSeal field type creates an unsatisfiable OTP step. |
| 6 | Recognition rather than recall | 3/4 | Labels are clear until the phone control introduces unexplained verification. |
| 7 | Flexibility and efficiency | 3/4 | Keyboard and readable mode work, but the primary phone path blocks progress. |
| 8 | Aesthetic and minimalist design | 3/4 | Calm document-first design; active phone chrome is visually noisy. |
| 9 | Error recovery | 2/4 | Download/OTP failures lack actionable recovery at the point of failure. |
| 10 | Help and documentation | 3/4 | Human recovery is present, but not contextual to field/download failures. |
| **Total** | | **26/40** | **Promising foundation with one signing blocker.** |

## Anti-Patterns Verdict

The surface does not look generically AI-generated. It is restrained, document-first, and preserves the authoritative PDF. The deterministic scan of `brand/` returned zero anti-pattern findings. The design failure is functional rather than decorative: the selected upstream control semantics contradict the label’s real-world meaning.

## Overall Impression

The responsive shell and fail-closed readable view are strong. The biggest opportunity is to stop treating source-level rendering as proof of the user journey. A signer can reach a clean-looking field and still enter an impossible verification flow.

## What's Working

- Exact UUID parity keeps the PDF visible until every readable target is proven.
- The mobile identity/action split remains stable without horizontal overflow.
- On a disposable live IIPP submission, pending Download returned HTTP 200 and a real browser download event, and the hidden active label stayed suppressed.

## Priority Issues

### [P0] Administrator phone invokes an unsatisfiable OTP flow

**Why it matters:** The owner cannot complete the first administrative table because DocuSeal `phone` means verification, not a formatted text value.

**Fix:** Store this one field as plain `text`, retain phone-sized geometry/presentation, and prove it accepts a synthetic formatted number without network verification.

**Suggested command:** `$impeccable harden`

### [P1] No real-user release gate

**Why it matters:** Synthetic DOM tests passed while production behavior remained broken.

**Fix:** Add disposable, outbound-disabled browser journeys that type, sign, validate, download, and clean up every state.

**Suggested command:** `$impeccable audit`

### [P2] Download failure resilience is unproven

**Why it matters:** The reported private-link failure did not reproduce on a fresh disposable submission, so stale state or an upstream error path may leave a confusing failure.

**Fix:** Test pending and completed downloads, force non-2xx/network failures, reset loading state, and announce recovery without rendering a dead control.

**Suggested command:** `$impeccable harden`

### [P2] Active field treatment depends on upstream control internals

**Why it matters:** The redundant readable label is correctly hidden in the fresh fixture, but the phone control’s own country/verification chrome creates the reported broken-looking bottom state.

**Fix:** Re-test all field types after phone becomes text; only patch selectors or Vue if a non-phone field reproduces the strip.

**Suggested command:** `$impeccable polish`

## Persona Red Flags

**First-time signer:** A field labeled only as an administrator phone number unexpectedly asks for a six-digit code. They will assume the document or their phone is broken.

**Mobile signer under time pressure:** A failed Download alert provides no explanation of whether download is unavailable, expired, or retryable.

**Keyboard/screen-reader signer:** The readable/PDF control is reachable and announced, but real upstream error and completion focus behavior is not yet proven end to end.

## Minor Observations

- The disposable pending Download succeeded, so the visible control is not universally misconfigured.
- The current active-label CSS worked on the fresh IIPP fixture; avoid broadening it without a failing non-phone reproduction.
- The complete public state matrix still needs actual browser evidence in both languages.

## Questions to Consider

- Why should any administrative data field trigger identity verification?
- Can a release be called ready without one full disposable completion and executed-PDF download?
- Should a Download action remain visible during a state where the backend will reject it?
