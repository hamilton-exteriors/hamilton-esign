const TYPE_CLASS = {
  checkbox: 'ds-box',
  date: 'ds-date',
  initials: 'ds-ini',
  phone: 'ds-phone',
  signature: 'ds-sig',
  text: '',
};

export function stampReflowAnchors(html, fields, mapping) {
  let output = html.replace(/ data-hx-uuid="[^"]*"/g, '');
  let stamped = 0;

  for (const field of fields) {
    const uuid = mapping.get(field.id);
    if (!uuid) throw new Error(`missing live UUID mapping for ${field.id}`);
    if (!(field.type in TYPE_CLASS)) throw new Error(`unsupported reflow field type ${field.type}`);

    const idToken = `id="${field.id}"`;
    let matched = false;
    output = output.replace(/<span\b[^>]*>/g, (tag) => {
      if (!tag.includes(idToken)) return tag;
      if (matched) throw new Error(`duplicate reflow anchor ${field.id}`);
      matched = true;

      let next = tag.replace(/\sdata-presentation="[^"]*"/g, '');
      next = next.replace(/\bdata-type="[^"]*"/, `data-type="${field.type}"`);
      if (!next.includes(`data-type="${field.type}"`)) next = next.replace(/>$/, ` data-type="${field.type}">`);
      if (field.presentation) next = next.replace(/>$/, ` data-presentation="${field.presentation}">`);
      next = next.replace(/\bclass="([^"]*)"/, (attribute, classes) => {
        const tokens = classes.split(/\s+/).filter(Boolean)
          .filter((token) => !Object.values(TYPE_CLASS).includes(token));
        const typeClass = field.presentation === 'phone' ? TYPE_CLASS.phone : TYPE_CLASS[field.type];
        if (typeClass) tokens.push(typeClass);
        return `class="${[...new Set(tokens)].join(' ')}"`;
      });
      next = next.replace(idToken, `id="${field.id}" data-hx-uuid="${uuid}"`);
      return next;
    });
    if (!matched) throw new Error(`missing reflow anchor ${field.id}`);
    stamped++;
  }

  return { html: output, stamped };
}
