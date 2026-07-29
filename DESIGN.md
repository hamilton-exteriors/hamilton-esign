---
name: Hamilton e-Sign
description: Phone-first employment and safety document signing for Hamilton Exteriors
colors:
  hamilton-green: "#256346"
  hamilton-deep: "#0D2B1D"
  light-green: "#E3EFD3"
  cream-surface: "#F4F1EB"
  paper-white: "#FFFFFF"
  ink: "#1A1A1A"
  muted-ink: "#5A5A5C"
  divider: "#C4BFB6"
  danger: "#991B1B"
  disabled-surface: "#D6D2CA"
  disabled-ink: "#4A4A4C"
typography:
  title:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.02em"
rounded:
  control: "8px"
  document: "6px"
  focus: "4px"
  mark: "3px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  control: "16px"
  lg: "20px"
  xl: "24px"
  footer: "28px"
components:
  button-primary:
    backgroundColor: "{colors.hamilton-deep}"
    textColor: "{colors.paper-white}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.hamilton-deep}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  document-surface:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.document}"
    padding: "16px"
---

# Design System: Hamilton e-Sign

## 1. Overview

**Creative North Star: "Field-ready paperwork"**

Hamilton e-Sign should feel prepared for a worker opening important paperwork from WhatsApp, often outdoors or away from a desk. The visual system is calm and familiar so attention stays on reading, filling, and signing. Brand recognition comes from Hamilton green, the mark, and a consistent human voice rather than decorative UI.

The component character is direct and reassuring. Controls state what happens, destructive choices remain visually distinct, and every dead end keeps a route to a person. The system rejects DocuSeal product marketing, decorative display typography, software theatrics, and any responsive treatment that risks hiding the only valid signing surface.

**Key Characteristics:**
- Phone-first document readability with a visible PDF escape hatch
- Restrained Hamilton palette with semantic danger kept separate
- Familiar controls sized for a thumb and explicit about consequences
- One self-hosted sans family across chrome and document reflow
- Structural borders and nearly flat elevation

## 2. Colors

The palette uses Hamilton green for identity and interaction, deep green for decisive controls, and quiet neutrals for document framing.

### Primary
- **Hamilton Green:** Used for focus, links, field markers, selected states, and low-emphasis interaction feedback.
- **Hamilton Deep:** Reserved for primary actions, headings, and high-confidence text.

### Secondary
- **Light Field Green:** A low-saturation field and hover wash that communicates where to act without looking like an error.

### Neutral
- **Cream Surface:** The application background that separates the white legal document from surrounding chrome.
- **Paper White:** The document and input surface.
- **Ink:** Primary reading text.
- **Muted Ink:** Secondary copy and footer detail; never used below WCAG AA contrast.
- **Divider:** Page edges, secondary controls, and structural boundaries.
- **Disabled Surface / Disabled Ink:** A readable disabled state that preserves the button label.

### Tertiary
- **Danger:** Used only for decline and genuine destructive or error states.

### Named Rules

**The Error Color Rule.** Danger red is forbidden for ordinary signable fields. Green identifies work to complete; red means an actual error or destructive action.

**The Document Contrast Rule.** The white legal page must remain visibly separate from the cream application surface through a line border, not a decorative shadow.

## 3. Typography

**Display Font:** DM Sans with system sans fallback  
**Body Font:** DM Sans with system sans fallback

**Character:** DM Sans is readable, compact, and neutral enough to disappear into the signing task. The logo carries the brand; UI text does not imitate display advertising.

### Hierarchy
- **Title** (600, 16px mobile / 18px desktop, 1.3): Document title in application chrome, balanced and allowed to wrap.
- **Headline** (600, 22px, 1.25): Reflowed document H1 only.
- **Section Title** (600, 18px, 1.3): Reflowed document H2.
- **Body** (400, 16px, 1.55): Reflowed document copy and primary instructions, capped near 70 characters when layout permits.
- **Label** (600, 12px, 0.02em): Compact controls and document utility chrome. Uppercase is limited to the short readable-view label.

### Named Rules

**The Chrome Is Not the Document Rule.** App titles stay compact and stable; legal-document hierarchy belongs inside the document surface.

## 4. Elevation

The elevation philosophy is structural flat. Borders, background changes, and whitespace establish hierarchy. Document pages use one restrained shadow only to clarify the physical page edge; buttons, panels, and footer content remain flat.

### Shadow Vocabulary
- **Document Edge** (`0 1px 2px rgba(13, 43, 29, 0.06)`): Applied only to the white PDF page surface against cream.
- **Tooltip Overlay** (`background: rgba(13, 43, 29, 0.92)`): A functional overlay with minimal blur, never a decorative glass panel.

### Named Rules

**The Structural Flat Rule.** A border or tonal surface must explain depth before a shadow is introduced. Wide ambient shadows are prohibited.

## 5. Components

### Buttons
- **Shape:** Gently curved controls (8px radius) with a minimum 44px touch height.
- **Primary:** Deep green fill, white label, reserved for the current signing step.
- **Hover / Focus:** State feedback lasts about 180ms with an exponential ease. Keyboard focus uses a 2px Hamilton green outline with 2px offset.
- **Secondary:** Transparent surface, deep green label, divider border, and a light green hover wash.
- **Danger:** Transparent surface, danger label and border, never the same fill as the primary action.
- **Disabled:** Opaque neutral fill and readable dark label; the action remains visibly unavailable without hiding its name.

### Cards / Containers
- **Corner Style:** Document surfaces use 6px radius; controls use 8px.
- **Background:** Cream application surface around white legal pages.
- **Shadow Strategy:** Structural flat; only the document edge carries a 1px by 2px low-opacity shadow.
- **Border:** One-pixel divider border identifies page and reflow boundaries.
- **Internal Padding:** 16px on compact mobile chrome, increasing only where the upstream layout requires it.

### Inputs / Fields
- **Style:** Paper-white controls with green translucent field markers and green active outlines.
- **Focus:** The global 2px green focus outline remains visible regardless of field type.
- **Error / Disabled:** Errors retain semantic red; disabled labels maintain at least WCAG AA contrast.
- **Placeholder:** Muted ink at full opacity, never low-contrast browser gray.

### Navigation
- The form progress rail is horizontal, compact, and scrollable for long documents. It conveys sequence without pushing the primary action below the fold. The current step and keyboard focus must be distinguishable without color alone.

### Readable Document View
- On phones, reflowed content uses 16px body text and receives the real DocuSeal field controls inline.
- The utility bar keeps a persistent way to show the legal PDF page.
- Reflow is admitted only when every active signer field has a unique valid anchor. Otherwise the visible PDF remains authoritative.

### Recovery Footer
- Every terminal state shows Hamilton's legal identity and a readable help line.
- Phone and WhatsApp actions are explicit, underlined, and sized for a thumb.
- AGPL source credit remains visible without becoming product marketing.

## 6. Do's and Don'ts

### Do:
- **Do** keep the document as the dominant surface and application chrome visually quiet.
- **Do** use Hamilton Green for focus, links, and signable fields, and Danger only for decline or genuine errors.
- **Do** preserve 44px touch targets, 2px focus outlines, readable placeholders, and reduced-motion behavior.
- **Do** test every state at 390px, 768px crossings, desktop width, 200% text zoom, keyboard-only input, English, and Spanish.
- **Do** keep a direct human recovery path on active, completed, declined, expired, archived, and awaiting pages.

### Don't:
- **Don't** add DocuSeal product marketing, white-label theater, or any page that promotes signing software during an employment task.
- **Don't** present a dense scaled-down Letter PDF as the only mobile reading experience.
- **Don't** style destructive decline controls like the primary continuation action.
- **Don't** use red or pink ordinary field markers that look like validation errors.
- **Don't** add decorative display typography, glass effects, gradients, oversized cards, or motion that distracts from reading and signing.
- **Don't** strand a worker in a recovery state without a clear phone or WhatsApp path to a person.
- **Don't** hide the PDF until every responsive field target is proven valid.
