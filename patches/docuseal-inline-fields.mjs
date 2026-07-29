// Patch DocuSeal 3.1.5's signer components so a field can render INLINE inside a
// reflowed document, instead of only as a percentage-positioned box over a page
// image. This is the missing half of what Adobe calls Liquid Mode.
//
// Every edit asserts its anchor text. If DocuSeal changes these files upstream
// the build FAILS here, loudly, rather than silently producing a bundle where
// fields no longer appear. That matters more than usual: the failure mode is an
// employment document that looks signable and captures nothing.
//
// Design note on why this stays small: area.vue's root element already carries
// Tailwind's `absolute`. Anchoring inline fields to a `position: relative` span
// means that class remains correct, so only the computed geometry and the font
// sizing need to change, not the markup.
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = process.argv[2] || '/src/app/javascript/submission_form';
let edits = 0;

const patch = (file, replacements) => {
  const path = `${DIR}/${file}`;
  let src = readFileSync(path, 'utf8');
  for (const [what, from, to] of replacements) {
    if (!src.includes(from)) {
      throw new Error(`PATCH FAILED in ${file}: anchor not found for "${what}".\n` +
        'DocuSeal changed this file. Re-derive the patch against the pinned version.');
    }
    if (src.includes(to)) throw new Error(`PATCH FAILED in ${file}: "${what}" already applied?`);
    src = src.replace(from, to);
    edits++;
    console.log(`  ok  ${file}: ${what}`);
  }
  writeFileSync(path, src);
};

// ---- areas.vue: choose an inline anchor when the reflowed view is on screen --
patch('areas.vue', [
  ['target lookup prefers an inline anchor',
    `    findPageElementForArea (area) {
      return (this.$root.$el?.parentNode?.getRootNode() || document).getElementById(\`page-\${area.attachment_uuid}-\${area.page}\`)
    },`,
    `    findPageElementForArea (area, field) {
      const root = (this.$root.$el?.parentNode?.getRootNode() || document)

      // Hamilton: when the reflowed reading view is visible, a field belongs in
      // the text, not over a page image. offsetParent is the visibility test —
      // the reading view and the page images are never shown at the same time,
      // so this also means desktop is completely unaffected.
      if (field) {
        const anchor = root.querySelector(\`[data-hx-uuid="\${field.uuid}"]\`)

        if (anchor && anchor.offsetParent !== null) return anchor
      }

      return root.getElementById(\`page-\${area.attachment_uuid}-\${area.page}\`)
    },`],
  ['pass the field to the lookup',
    'v-for="(pageElem, index) in [findPageElementForArea(area)]"',
    'v-for="(pageElem, index) in [findPageElementForArea(area, field)]"'],
  ['tell the field area it is inline',
    `            <FieldArea
              :ref="setAreaRef"`,
    `            <FieldArea
              :ref="setAreaRef"
              :inline="!!pageElem.dataset?.hxUuid"`],
  ['re-resolve targets once the reading view exists',
    `  beforeUpdate () {
    this.areaRefs = []
  },`,
    `  beforeUpdate () {
    this.areaRefs = []
  },
  mounted () {
    // Hamilton: the reading view is injected after an async fetch, so it can
    // land after this component has already mounted and chosen page images as
    // its Teleport targets. Injecting DOM is not a reactive change, so nothing
    // would move the fields into the text until the next step change. Re-render
    // on demand instead.
    this.onReflowReady = () => this.$forceUpdate()
    window.addEventListener('hx-reflow-ready', this.onReflowReady)
  },
  beforeUnmount () {
    window.removeEventListener('hx-reflow-ready', this.onReflowReady)
  },`],
]);

// ---- area.vue: render inline instead of positioned by page percentages -------
patch('area.vue', [
  ['expose field UUID for fail-closed parity checks',
    `    class="flex absolute lg:text-base -outline-offset-1 focus-visible:outline-blue-500 focus-visible:outline-2 focus-visible:outline field-area"
    dir="auto"`,
    `    class="flex absolute lg:text-base -outline-offset-1 focus-visible:outline-blue-500 focus-visible:outline-2 focus-visible:outline field-area"
    :data-uuid="field.uuid"
    dir="auto"`],
  ['inline prop',
    `  props: {
`,
    `  props: {
    // Hamilton: render in the text flow of the reflowed reading view rather than
    // as a box positioned by percentages of a page image.
    inline: {
      type: Boolean,
      required: false,
      default: false
    },
`],
  ['inline geometry fills its anchor',
    `      const style = {
        top: y * 100 + '%',
        left: x * 100 + '%',
        width: w * 100 + '%',
        height: h * 100 + '%'
      }`,
    `      const style = this.inline
        // The anchor span is position:relative and already sized by the reading
        // view's stylesheet, so the field simply fills it. The page percentages
        // are meaningless once the page is gone.
        ? { top: '0', left: '0', width: '100%', height: '100%' }
        : {
            top: y * 100 + '%',
            left: x * 100 + '%',
            width: w * 100 + '%',
            height: h * 100 + '%'
          }`],
  ['inline text inherits the reading view size',
    `    fontStyle () {
      let fontSize = ''`,
    `    fontStyle () {
      // Hamilton: inline fields inherit the reading view's own type size. The
      // sizing below is expressed in container-query and viewport units scaled
      // to a page image, which is exactly what we no longer have.
      if (this.inline) return {}

      let fontSize = ''`],
]);

console.log(`\n${edits} edit(s) applied`);
