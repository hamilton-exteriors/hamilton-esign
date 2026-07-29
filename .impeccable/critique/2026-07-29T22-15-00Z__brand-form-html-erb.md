---
target: public signer experience
total_score: 40
p0_count: 0
p1_count: 0
timestamp: 2026-07-29T22-15-00Z
slug: brand-form-html-erb
---
# Public signer experience post-release critique

## Design Health Score

| # | Heuristic | Score | Verified outcome |
|---|---|---:|---|
| 1 | Visibility of system status | 4/4 | Loading, required-field, completion, decline, and retry states are visible. |
| 2 | Match system / real world | 4/4 | Administrator phone is ordinary text; signer copy uses document titles, not filenames. |
| 3 | User control and freedom | 4/4 | PDF/readable switching, decline Escape, and duplicate-tab terminal behavior passed. |
| 4 | Consistency and standards | 4/4 | English/Spanish controls, heading hierarchy, field styling, and actions are coherent. |
| 5 | Error prevention | 4/4 | Required fields gate completion; phone no longer invokes OTP; signature mode race is guarded. |
| 6 | Recognition rather than recall | 4/4 | Labels, Today actions, progress, and completion copy remain contextual. |
| 7 | Flexibility and efficiency | 4/4 | Keyboard, reduced motion, responsive reading, typed signature, and downloads passed. |
| 8 | Aesthetic and minimalist design | 4/4 | Calm document-first layout preserves legal hierarchy without extra chrome. |
| 9 | Error recovery | 4/4 | Download failures reset state; invalid readable parity fails back to the PDF. |
| 10 | Help and documentation | 4/4 | Bilingual recovery and direct contact options remain present throughout. |
| **Total** | | **40/40** | **No unresolved P0-P3 findings.** |

## Independent assessments

Assessment A reviewed the live visual hierarchy and all ten Nielsen heuristics. Assessment B independently challenged every proposed finding against field ownership, selector scope, generated markup, and production evidence. It rejected the employer-field and hypothetical error-color false positives. The two surviving P3 findings were fixed before this snapshot: readable legal H1s now remain larger than H2s, and the IIPP no longer exposes an internal Markdown filename.

The deterministic Impeccable detector returned zero findings for `brand/` before and after the final fixes.

## Production evidence

- Both production hosts returned 200 after Railway deployment `0be07a92-8d07-470a-b696-f0af74822a16` reached SUCCESS.
- Mobile 320, 375, 390, 414, and 767 px passed with no page overflow, exact 5/5 readable UUID parity, no visible PDF pages while readable mode was active, and 44 px visible actions.
- Phone landscape and 1280 px desktop remained PDF-first with all six pages visible.
- English and Spanish root/signer routes localized correctly. Missing and `/start` routes rendered the branded bilingual 404 recovery page.
- A disposable IIPP accepted a synthetic administrative phone as plain text, showed no OTP, preserved it into the executed PDF, accepted Today dates and a typed signature, completed, and downloaded a six-page executed PDF.
- Pending and completed downloads both produced real browser download events.
- Required-field validation, duplicate completed tabs, synthetic decline, archived/unavailable state, and rapid Type/Draw switching passed.
- Every disposable submission was archived and API-verified; retained downloads and screenshots were removed.

## Trend

Baseline: **26/40**, with one P0, one P1, and two P2 findings.

Current: **40/40**, with no unresolved P0-P3 findings.
