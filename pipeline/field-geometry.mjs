import { PAGE } from './build-docs.mjs';

const MINIMUM_PX = {
  checkbox: { w: 13, h: 13 },
  date: { w: 130, h: 21 },
  initials: { w: 44, h: 21 },
  phone: { w: 150, h: 21 },
  signature: { w: 90, h: 21 },
  text: { w: 180, h: 21 },
};

function semanticType(name) {
  const value = String(name || '').toLowerCase();
  if (/^administrator phone$/i.test(value.trim())) return 'text';
  if (/\bphone\b|\btelephone\b|\btel[eé]fono\b|\bcelular\b/.test(value)) return 'phone';
  if (/\binitials?\b|\binicial(?:es)?\b/.test(value)) return 'initials';
  if (/\bsignature\b|\bfirma\b/.test(value)) return 'signature';
  if (/\bdate\b|\bfecha\b|\beffective\b|\breviewed\s*\/\s*updated\b/.test(value)) return 'date';
  return null;
}

export function validateGeneratedGeometry(document, page = PAGE) {
  const problems = [];
  const tolerance = 1;
  const fields = document.fields || [];
  for (const field of fields) {
    const values = [field.x, field.y, field.w, field.h];
    if (!values.every(Number.isFinite)) {
      problems.push(`${field.name}: non-finite geometry`);
      continue;
    }
    if (!Number.isInteger(field.page) || field.page < 0 || field.page >= document.pageCount) {
      problems.push(`${field.name}: invalid page ${field.page}`);
    }
    if (field.x < (page.ml - tolerance) / page.w ||
        field.x + field.w > (page.w - page.mr + tolerance) / page.w ||
        field.y < (page.mt - tolerance) / page.h ||
        field.y + field.h > (page.h - page.mb + tolerance) / page.h) {
      problems.push(`${field.name}: outside page content bounds`);
    }
    const minimum = field.presentation === 'phone' ? MINIMUM_PX.phone : MINIMUM_PX[field.type];
    if (!minimum) {
      problems.push(`${field.name}: unsupported type ${field.type}`);
    } else if (field.w * page.w + tolerance < minimum.w || field.h * page.h + tolerance < minimum.h) {
      problems.push(`${field.name}: ${Math.round(field.w * page.w)}x${Math.round(field.h * page.h)}px is too small for ${field.presentation || field.type}`);
    }
    const expected = semanticType(field.name);
    if (expected && expected !== field.type) {
      problems.push(`${field.name}: semantic type ${expected}, got ${field.type}`);
    }
  }

  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const left = fields[i];
      const right = fields[j];
      if (left.page !== right.page) continue;
      const overlapW = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
      const overlapH = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
      if (overlapW * page.w > tolerance && overlapH * page.h > tolerance) {
        problems.push(`${left.name} overlaps ${right.name} on page ${left.page + 1}`);
      }
    }
  }
  return problems;
}
