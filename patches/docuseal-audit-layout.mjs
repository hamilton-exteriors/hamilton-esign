// Patch DocuSeal 3.1.5's Audit Log generator so a checkbox label and its value
// are one pagination unit. Upstream emits them as separate Composer boxes, which
// can strand a bare "True" at the top of the next certificate page.
//
// Both replacements assert exact pinned-source anchors. A DocuSeal upgrade must
// fail the image build until this patch is re-derived against the new generator.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2] || '/app/lib/submissions/generate_audit_trail.rb';
let source = readFileSync(path, 'utf8');

const replacements = [
  [
    'suppress the standalone checkbox label box',
    `                  text: TextUtils.maybe_rtl_reverse(field_name).upcase.presence ||
                        "#{I18n.t("#{field['type']}_field")} #{submitter_field_counters[field['type']]}".upcase,`,
    `                  text: field_type == 'checkbox' ? '' :
                        TextUtils.maybe_rtl_reverse(field_name).upcase.presence ||
                        "#{I18n.t("#{field['type']}_field")} #{submitter_field_counters[field['type']]}".upcase,`,
  ],
  [
    'keep checkbox label and value together',
    `            elsif field_type == 'checkbox'
              composer.formatted_text_box([{ text: value.to_s.titleize }], padding: [0, 0, 10, 0])`,
    `            elsif field_type == 'checkbox'
              checkbox_label = TextUtils.maybe_rtl_reverse(field_name).upcase.presence ||
                               "#{I18n.t("#{field['type']}_field")} " \\
                               "#{submitter_field_counters[field['type']]}".upcase

              composer.formatted_text_box(
                [
                  { text: "#{checkbox_label}\\n", font_size: 6 },
                  { text: value.to_s.titleize }
                ],
                text_align: field_name.to_s.match?(RTL_REGEXP) ? :right : :left,
                line_spacing: 1.3, padding: [0, 0, 10, 0]
              )`,
  ],
];

for (const [name, from, to] of replacements) {
  if (!source.includes(from)) {
    throw new Error(`PATCH FAILED: anchor not found for "${name}". Re-derive against pinned DocuSeal 3.1.5.`);
  }
  if (source.includes(to)) throw new Error(`PATCH FAILED: "${name}" already applied`);
  source = source.replace(from, to);
  console.log(`  ok  audit generator: ${name}`);
}

writeFileSync(path, source);
