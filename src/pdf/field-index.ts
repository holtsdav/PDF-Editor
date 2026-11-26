import { PDFTextField } from 'pdf-lib';
import type { PDFField, PDFForm } from 'pdf-lib';

export interface FieldIndex {
  maybe(name: string): PDFField | undefined;
  text(name: string): PDFTextField;
  has(name: string): boolean;
  add(field: PDFField): void;
  forget(name: string): void;
}

/**
 * pdf-lib's form.getField*() rebuilds every field and its fully qualified name on each
 * call, so per-field lookups cost O(fields) each. Index the names once per document.
 */
export function fieldIndex(form: PDFForm): FieldIndex {
  let index: Map<string, PDFField> | undefined;
  const all = () => (index ??= new Map(form.getFields().map((field) => [field.getName(), field])));
  return {
    maybe: (name) => all().get(name),
    text(name) {
      const field = all().get(name);
      if (!(field instanceof PDFTextField)) {
        throw new Error(`The PDF has no editable text field named ${name}.`);
      }
      return field;
    },
    has: (name) => all().has(name),
    add(field) {
      all().set(field.getName(), field);
    },
    forget(name) {
      all().delete(name);
    },
  };
}
