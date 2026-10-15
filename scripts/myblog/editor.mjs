// 编辑器的文字模型：按行存，光标按「字」计；折行后的上下移动、按词移动、撤销重做。
import { breakLine, charWidth, graphemes } from './terminal.mjs';

const words = new Intl.Segmenter('zh', { granularity: 'word' });
const UNDO_LIMIT = 500;

export class TextBuffer {
  constructor(text = '') {
    this.lines = text.replace(/\r\n?/g, '\n').split('\n');
    this.line = 0;
    this.col = 0;
    this.goal = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastEdit = { kind: '', time: 0 };
    this.version = 0;
  }

  get text() {
    return this.lines.join('\n');
  }

  parts(line = this.line) {
    return graphemes(this.lines[line] ?? '');
  }

  /* ---------- 撤销 ---------- */

  /** 连续打字、连续删除在 1.5 秒内合并成一步撤销。 */
  record(kind) {
    const now = Date.now();
    const merge = kind !== 'other' && kind === this.lastEdit.kind && now - this.lastEdit.time < 1500;
    if (!merge) {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    this.lastEdit = { kind, time: now };
    this.redoStack = [];
  }

  snapshot() {
    return { lines: this.lines.slice(), line: this.line, col: this.col };
  }

  restore(state) {
    this.lines = state.lines;
    this.line = state.line;
    this.col = state.col;
    this.lastEdit = { kind: '', time: 0 };
    this.changed();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    return true;
  }

  changed() {
    this.version += 1;
    this.goal = null;
  }

  /* ---------- 编辑 ---------- */

  insert(text) {
    const clean = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
    if (!clean) return;
    this.record(clean === '\n' ? 'newline' : clean.includes('\n') ? 'other' : 'insert');
    const parts = this.parts();
    const pieces = clean.split('\n');
    const last = pieces.length - 1;
    pieces[0] = parts.slice(0, this.col).join('') + pieces[0];
    const beforeCursor = pieces[last];
    pieces[last] += parts.slice(this.col).join('');
    this.lines.splice(this.line, 1, ...pieces);
    this.line += last;
    this.col = graphemes(beforeCursor).length;
    this.changed();
  }

  backspace() {
    if (this.col > 0) {
      this.record('delete');
      const parts = this.parts();
      this.lines[this.line] = parts.slice(0, this.col - 1).join('') + parts.slice(this.col).join('');
      this.col -= 1;
    } else if (this.line > 0) {
      this.record('delete');
      const previous = this.lines[this.line - 1];
      this.lines.splice(this.line - 1, 2, previous + this.lines[this.line]);
      this.line -= 1;
      this.col = graphemes(previous).length;
    } else {
      return;
    }
    this.changed();
  }

  deleteForward() {
    const parts = this.parts();
    if (this.col < parts.length) {
      this.record('delete');
      this.lines[this.line] = parts.slice(0, this.col).join('') + parts.slice(this.col + 1).join('');
    } else if (this.line < this.lines.length - 1) {
      this.record('delete');
      this.lines.splice(this.line, 2, this.lines[this.line] + this.lines[this.line + 1]);
    } else {
      return;
    }
    this.changed();
  }

  /** Option+Backspace：删到上一个词的开头（中文按词典分词）。 */
  deleteWordBackward() {
    if (this.col === 0) return this.backspace();
    const target = this.wordStop(-1);
    this.record('other');
    const parts = this.parts();
    this.lines[this.line] = parts.slice(0, target).join('') + parts.slice(this.col).join('');
    this.col = target;
    this.changed();
  }

  /** 用 text 替换第 start 到 end 行，光标放到替换内容的末尾。 */
  replaceLines(start, end, text) {
    this.record('other');
    const pieces = text.split('\n');
    this.lines.splice(start, end - start + 1, ...pieces);
    this.line = start + pieces.length - 1;
    this.col = graphemes(pieces.at(-1)).length;
    this.changed();
  }

  /* ---------- 光标 ---------- */

  setCursor(line, col) {
    this.line = clamp(line, 0, this.lines.length - 1);
    this.col = clamp(col, 0, this.parts().length);
    this.goal = null;
  }

  left() {
    if (this.col > 0) this.col -= 1;
    else if (this.line > 0) this.setCursor(this.line - 1, Infinity);
    this.goal = null;
  }

  right() {
    if (this.col < this.parts().length) this.col += 1;
    else if (this.line < this.lines.length - 1) this.setCursor(this.line + 1, 0);
    this.goal = null;
  }

  home() {
    this.setCursor(this.line, 0);
  }

  end() {
    this.setCursor(this.line, Infinity);
  }

  wordLeft() {
    if (this.col === 0) return this.left();
    this.setCursor(this.line, this.wordStop(-1));
  }

  wordRight() {
    if (this.col >= this.parts().length) return this.right();
    this.setCursor(this.line, this.wordStop(1));
  }

  /** 当前行里，向左（-1）或向右（1）最近的词边界，返回字的下标。 */
  wordStop(direction) {
    const parts = this.parts();
    const text = this.lines[this.line];
    const offset = parts.slice(0, this.col).join('').length;
    const segments = Array.from(words.segment(text));
    let target = direction < 0 ? 0 : text.length;
    if (direction < 0) {
      for (const segment of segments) {
        if (segment.index >= offset) break;
        if (segment.isWordLike) target = segment.index;
      }
    } else {
      for (const segment of segments) {
        const end = segment.index + segment.segment.length;
        if (end > offset && segment.isWordLike) {
          target = end;
          break;
        }
      }
    }
    return graphemes(text.slice(0, target)).length;
  }

  /** 按屏幕上的折行上下移动，尽量保持在同一列。 */
  vertical(delta, width) {
    const rows = layout(this.lines, width);
    const index = cursorRow(rows, this);
    const row = rows[index];
    const x = this.goal ?? widthOf(this.parts().slice(row.start, this.col));
    const targetIndex = clamp(index + delta, 0, rows.length - 1);
    if (targetIndex === index) {
      this.setCursor(this.line, delta < 0 ? 0 : Infinity);
      return;
    }
    const target = rows[targetIndex];
    const parts = this.parts(target.line);
    const lastOfLine = rows[targetIndex + 1]?.line !== target.line;
    const limit = lastOfLine ? target.end : target.end - 1;
    let col = target.start;
    let used = 0;
    while (col < limit && used + charWidth(parts[col]) <= x) {
      used += charWidth(parts[col]);
      col += 1;
    }
    this.line = target.line;
    this.col = col;
    this.goal = x;
  }

  /* ---------- [[ 链接 ---------- */

  /** 光标前是 [[ 加几个字时，返回这几个字（用来提示文章标题）。 */
  linkQuery() {
    const before = this.parts().slice(0, this.col).join('');
    return before.match(/\[\[([^[\]|#\n]*)$/)?.[1] ?? null;
  }

  /** 用选中的标题补全 [[ 链接。 */
  completeLink(title) {
    const query = this.linkQuery();
    if (query === null) return;
    const parts = this.parts();
    const after = parts.slice(this.col).join('');
    const before = parts.slice(0, this.col - graphemes(query).length).join('');
    const closing = after.startsWith(']]') ? '' : ']]';
    this.record('other');
    this.lines[this.line] = before + title + closing + after;
    this.col = graphemes(before + title).length + 2;
    this.changed();
  }
}

/** 整篇按宽度折行后的每一行：{ line, start, end }（start/end 是这一行里字的下标）。 */
export function layout(lines, width) {
  const rows = [];
  lines.forEach((text, line) => {
    for (const [start, end] of breakLine(graphemes(text), width)) rows.push({ line, start, end });
  });
  return rows;
}

/** 光标落在折行后的哪一行。 */
export function cursorRow(rows, buffer) {
  let found = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.line < buffer.line) continue;
    if (row.line > buffer.line) break;
    found = index;
    if (buffer.col < row.end) break;
  }
  return found;
}

export function widthOf(parts) {
  return parts.reduce((sum, part) => sum + charWidth(part), 0);
}

/** 字数：中文按字，英文按词。 */
export function wordCount(text) {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.replace(/\p{Script=Han}/gu, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return han + latin;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
