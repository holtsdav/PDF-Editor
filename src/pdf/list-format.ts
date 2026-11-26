/**
 * Bulleted and numbered lists with indentation as plain text in a text box.
 * Markers are real characters, so the saved PDF looks the same in every reader.
 */
export const INDENT = '    ';
export const MAX_LEVEL = 6;
const BULLETS = ['•', '–', '‣'];
export type ListKind = 'bullet' | 'number';
export interface TextEdit {
  value: string;
  start: number;
  end: number;
}
interface Line {
  level: number;
  /** Extra spaces that are not a full indent level. */
  rest: string;
  kind?: ListKind;
  marker: string;
  text: string;
}

const LINE = /^((?: {4})*)( {0,3})(?:([•◦▪‣–-]) |(\d{1,3}|[a-z])([.)]) )?(.*)$/s;

function parse(line: string): Line {
  const match = LINE.exec(line)!;
  const level = match[1]!.length / INDENT.length;
  if (match[3]) {
    return { level, rest: match[2]!, kind: 'bullet', marker: `${match[3]} `, text: match[6]! };
  }
  if (match[4]) {
    return {
      level,
      rest: match[2]!,
      kind: 'number',
      marker: `${match[4]}${match[5]} `,
      text: match[6]!,
    };
  }
  return { level, rest: match[2]!, marker: '', text: match[6]! };
}

function bullet(level: number): string {
  return `${BULLETS[level % BULLETS.length]} `;
}

function numberLabel(level: number, count: number): string {
  // Even levels count 1. 2. 3., odd levels a. b. c.
  return level % 2 ? `${String.fromCharCode(96 + ((count - 1) % 26) + 1)}. ` : `${count}. `;
}

function format(line: Line): string {
  return INDENT.repeat(line.level) + line.rest + line.marker + line.text;
}

/**
 * Renumber the list blocks that contain lines first..last. A block is a run of
 * consecutive list lines; other text (e.g. a line starting with "2024. ") is never touched.
 */
export function renumber(value: string, first = 0, last = Infinity): string {
  const lines = value.split('\n').map(parse);
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]!.kind) {
      index++;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length && lines[end + 1]!.kind) {
      end++;
    }
    if (end >= first && index <= last) {
      const counters: number[] = [];
      for (let i = index; i <= end; i++) {
        const line = lines[i]!;
        counters.length = line.level + 1;
        if (line.kind === 'number') {
          counters[line.level] = (counters[line.level] ?? 0) + 1;
          line.marker = numberLabel(line.level, counters[line.level]!);
        } else {
          counters[line.level] = 0;
        }
      }
    }
    index = end + 1;
  }
  return lines.map(format).join('\n');
}

/** Line index range covered by a selection. */
function lineRange(value: string, start: number, end: number): [number, number] {
  const first = value.slice(0, start).split('\n').length - 1;
  const lastEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const last = value.slice(0, lastEnd).split('\n').length - 1;
  return [first, Math.max(first, last)];
}

/**
 * Apply a per-line change and keep the caret/selection on the same text:
 * offsets move by how much each touched line's prefix grew or shrank.
 */
function editLines(edit: TextEdit, change: (line: Line) => void, renumbered = true): TextEdit {
  const raw = edit.value.split('\n');
  const [first, last] = lineRange(edit.value, edit.start, edit.end);
  const before = raw.map((line) => line.length);
  const prefix = raw.map((line) => line.length - parse(line).text.length);
  for (let i = first; i <= last; i++) {
    const line = parse(raw[i]!);
    change(line);
    raw[i] = format(line);
  }
  let value = raw.join('\n');
  if (renumbered) {
    value = renumber(value, Math.max(0, first - 1), last + 1);
  }
  const after = value.split('\n');
  const move = (offset: number) => {
    let index = 0;
    let position = 0;
    while (index < before.length - 1 && position + before[index]! < offset) {
      position += before[index]! + 1;
      index++;
    }
    const column = offset - position;
    const newPrefix = after[index]!.length - parse(after[index]!).text.length;
    const lineStart = after.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
    // Inside the old prefix the caret snaps to the start of the text.
    const shifted = column <= prefix[index]! ? newPrefix : column - prefix[index]! + newPrefix;
    return lineStart + Math.min(shifted, after[index]!.length);
  };
  return { value, start: move(edit.start), end: move(edit.end) };
}

/** Toggle bullets or numbering on the selected lines (Word/Docs behaviour). */
export function toggleList(edit: TextEdit, kind: ListKind): TextEdit {
  const lines = edit.value.split('\n');
  const [first, last] = lineRange(edit.value, edit.start, edit.end);
  const selected = lines.slice(first, last + 1).map(parse);
  const remove = selected.every((line) => line.kind === kind || (!line.text && !line.kind));
  return editLines(edit, (line) => {
    if (remove) {
      line.kind = undefined;
      line.marker = '';
      return;
    }
    line.kind = kind;
    line.rest = '';
    line.marker = kind === 'bullet' ? bullet(line.level) : numberLabel(line.level, 1);
  });
}

/** Indent (+1) or outdent (-1) the selected lines; list markers follow their level. */
export function indent(edit: TextEdit, direction: 1 | -1): TextEdit {
  return editLines(edit, (line) => {
    if (direction < 0 && line.rest) {
      line.rest = '';
    } else {
      line.level = Math.max(0, Math.min(MAX_LEVEL, line.level + direction));
    }
    if (line.kind === 'bullet') {
      line.marker = bullet(line.level);
    }
  });
}

/** Whether the caret's line is a list item (Enter and Tab then act on the list). */
export function inList(edit: TextEdit): boolean {
  const [first] = lineRange(edit.value, edit.start, edit.start);
  return !!parse(edit.value.split('\n')[first]!).kind;
}

/**
 * Enter inside a list item continues the list; Enter on an empty item ends it
 * (or moves it up one level). Returns undefined when Enter should behave normally.
 */
export function continueList(edit: TextEdit): TextEdit | undefined {
  const lines = edit.value.split('\n');
  const [index] = lineRange(edit.value, edit.start, edit.start);
  const line = parse(lines[index]!);
  if (!line.kind) {
    return undefined;
  }
  if (!line.text.trim() && edit.start === edit.end) {
    if (line.level > 0) {
      return indent(edit, -1);
    }
    return editLines(edit, (item) => {
      item.kind = undefined;
      item.marker = '';
      item.rest = '';
    });
  }
  const marker = line.kind === 'bullet' ? bullet(line.level) : numberLabel(line.level, 1);
  const insert = `\n${INDENT.repeat(line.level)}${line.rest}${marker}`;
  const value = edit.value.slice(0, edit.start) + insert + edit.value.slice(edit.end);
  const caret = edit.start + insert.length;
  const renumbered = renumber(value, index, index + 1);
  // Renumbering can change label widths (9. → 10.) before the caret.
  const lineIndex = value.slice(0, caret).split('\n').length - 1;
  const oldLines = value.split('\n');
  const newLines = renumbered.split('\n');
  const lineStart = newLines.slice(0, lineIndex).reduce((sum, item) => sum + item.length + 1, 0);
  const column =
    caret -
    oldLines.slice(0, lineIndex).reduce((sum, item) => sum + item.length + 1, 0) +
    (newLines[lineIndex]!.length - oldLines[lineIndex]!.length);
  return { value: renumbered, start: lineStart + column, end: lineStart + column };
}
