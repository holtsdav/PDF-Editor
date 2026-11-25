import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { continueList, indent, inList, renumber, toggleList } from '../src/pdf/list-format.ts';
import type { TextEdit } from '../src/pdf/list-format.ts';

const at = (value: string, start = 0, end = start): TextEdit => ({ value, start, end });

test('bullets and numbers toggle on the selected lines and keep the caret on the text', () => {
  const value = 'Milk\nEggs\nBread';
  const bullets = toggleList(at(value, 0, value.length), 'bullet');
  assert.equal(bullets.value, '• Milk\n• Eggs\n• Bread');
  assert.equal(bullets.end, bullets.value.length);
  const numbers = toggleList(bullets, 'number');
  assert.equal(numbers.value, '1. Milk\n2. Eggs\n3. Bread');
  assert.equal(toggleList(numbers, 'number').value, value);
  // Caret inside "Eggs" (after "Eg") stays after "Eg".
  const caret = toggleList(at(value, 7), 'number');
  assert.equal(caret.value, 'Milk\n1. Eggs\nBread');
  assert.equal(caret.value.slice(0, caret.start), 'Milk\n1. Eg');
});

test('indenting nests items, changes bullet style and numbers each level separately', () => {
  let edit = toggleList(at('One\nTwo\nThree\nFour'), 'number');
  edit = toggleList(at(edit.value, 0, edit.value.length), 'number');
  assert.equal(edit.value, '1. One\n2. Two\n3. Three\n4. Four');
  const second = edit.value.indexOf('Two');
  const third = edit.value.indexOf('Three') + 2;
  edit = indent(at(edit.value, second, third), 1);
  assert.equal(edit.value, '1. One\n    a. Two\n    b. Three\n2. Four');
  edit = indent(edit, -1);
  assert.equal(edit.value, '1. One\n2. Two\n3. Three\n4. Four');
  const bullets = indent(toggleList(at('A\nB', 2), 'bullet'), 1);
  assert.equal(bullets.value, 'A\n    – B');
  // Plain text can be indented too.
  assert.equal(indent(at('Paragraph'), 1).value, '    Paragraph');
  assert.equal(indent(at('    Paragraph'), -1).value, 'Paragraph');
});

test('Enter continues a list, Enter on an empty item ends it', () => {
  const first = continueList(at('1. Milk', 7))!;
  assert.equal(first.value, '1. Milk\n2. ');
  assert.equal(first.start, first.value.length);
  const ended = continueList(first)!;
  assert.equal(ended.value, '1. Milk\n');
  assert.equal(continueList(at('Plain', 5)), undefined);
  // Inserting in the middle renumbers the following items.
  const middle = continueList(at('1. A\n2. B', 4))!;
  assert.equal(middle.value, '1. A\n2. \n3. B');
  assert.equal(middle.value.slice(0, middle.start), '1. A\n2. ');
  // An empty nested item moves up one level first.
  const nested = continueList(at('• A\n    – ', 10))!;
  assert.equal(nested.value, '• A\n• ');
  assert.ok(inList(at('• A', 1)));
  assert.ok(!inList(at('A', 1)));
});

test('numbering never touches text outside the edited list', () => {
  const text = '2024. was a good year\n\n5. A\n7. B';
  assert.equal(renumber(text, 2, 3), '2024. was a good year\n\n1. A\n2. B');
  const edit = toggleList(at('2024. was a good year\nItem', 23), 'bullet');
  assert.equal(edit.value, '2024. was a good year\n• Item');
});

test('the embedded fonts can draw every list marker', async () => {
  for (const name of ['NotoSans-Regular', 'NotoSerif-Regular', 'NotoSansMono-Regular']) {
    const font = fontkit.create(
      new Uint8Array(await readFile(new URL(`../assets/fonts/${name}.ttf`, import.meta.url))),
    ) as { hasGlyphForCodePoint(code: number): boolean };
    for (const marker of '•–‣') {
      assert.ok(font.hasGlyphForCodePoint(marker.codePointAt(0)!), `${name} has ${marker}`);
    }
  }
});
