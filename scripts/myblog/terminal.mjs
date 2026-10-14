// 终端：算字宽（中文占两格）、把输入解析成按键、整屏绘制。

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const graphemeCache = new Map();

/** 按「看到的一个字」切开，表情和组合字符不会被拆散。 */
export function graphemes(text) {
  let result = graphemeCache.get(text);
  if (!result) {
    result = Array.from(segmenter.segment(text), (part) => part.segment);
    if (graphemeCache.size > 5000) graphemeCache.clear();
    graphemeCache.set(text, result);
  }
  return result;
}

export function charWidth(grapheme) {
  const code = grapheme.codePointAt(0);
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (grapheme.includes('️') || /\p{Emoji_Presentation}/u.test(grapheme)) return 2;
  return isWide(code) ? 2 : 1;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function textWidth(text) {
  let width = 0;
  for (const grapheme of graphemes(text)) width += charWidth(grapheme);
  return width;
}

/** 截到不超过 width 格。 */
export function clip(text, width) {
  let result = '';
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const w = charWidth(grapheme);
    if (used + w > width) break;
    result += grapheme;
    used += w;
  }
  return result;
}

/**
 * 把一行（已切好的字）按宽度折成几段，返回每段的 [起, 止)。
 * 中文逐字折；折在英文单词中间时，单词不长就挪到下一行。
 */
export function breakLine(parts, width) {
  if (!parts.length) return [[0, 0]];
  const rows = [];
  let start = 0;
  while (start < parts.length) {
    let end = start;
    let used = 0;
    while (end < parts.length && (end === start || used + charWidth(parts[end]) <= width)) {
      used += charWidth(parts[end]);
      end += 1;
    }
    if (end < parts.length && isLatin(parts[end]) && isLatin(parts[end - 1])) {
      let wordStart = end - 1;
      while (wordStart > start && isLatin(parts[wordStart - 1])) wordStart -= 1;
      if (wordStart > start && end - wordStart <= 16) end = wordStart;
    } else if (parts[end] === ' ') {
      // 行尾的空格留在这一行，下一行不以空格开头。
      end += 1;
    }
    rows.push([start, end]);
    start = end;
  }
  return rows;
}

function isLatin(grapheme) {
  return /^[\p{L}\p{N}'’_.-]$/u.test(grapheme) && charWidth(grapheme) === 1;
}

/** 普通文字按宽度折行，用在 AI 面板和提示里。 */
export function wrap(text, width) {
  return String(text)
    .split('\n')
    .flatMap((line) => {
      const parts = graphemes(line);
      return breakLine(parts, width).map(([start, end]) => parts.slice(start, end).join(''));
    });
}

/* ---------- 样式 ---------- */

const SGR = {
  plain: '',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  accent: '\x1b[38;5;173m',
  strong: '\x1b[1;38;5;173m',
  ok: '\x1b[32m',
  error: '\x1b[31m',
  inverse: '\x1b[7m',
};

/** 一行由若干段 [文字, 样式] 组成。截到 width 并补齐空格，返回带颜色的字符串。 */
export function paint(segments, width) {
  let used = 0;
  let output = '';
  for (const [text, style = 'plain'] of segments) {
    if (used >= width) break;
    const piece = clip(String(text), width - used);
    if (!piece) continue;
    output += style === 'plain' ? piece : `${SGR[style]}${piece}\x1b[0m`;
    used += textWidth(piece);
  }
  return output + ' '.repeat(Math.max(0, width - used));
}

/* ---------- 按键 ---------- */

const CSI_KEYS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'backtab' };
const TILDE_KEYS = { 1: 'home', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * 把终端送来的原始输入解析成按键，交给 onKey：
 * { name: 'text', text }  一串普通文字（输入法一次上屏的整句也是一个事件）
 * { name: 'paste', text } 粘贴或拖进来的内容
 * { name: 'up' | 'enter' | 'backspace' | 'escape' | …, ctrl, alt, shift }
 * { name: 'p', ctrl: true } 这样的组合键
 */
export function createKeyReader(onKey) {
  let pasted = null;
  let carry = '';

  return function read(data) {
    let input = carry + String(data);
    carry = '';
    while (input) {
      if (pasted !== null) {
        const end = input.indexOf(PASTE_END);
        if (end < 0) {
          // 结束标记可能被拆到下一段，留几个字符到下次再拼。
          const keep = Math.min(input.length, PASTE_END.length - 1);
          pasted += input.slice(0, input.length - keep);
          carry = input.slice(input.length - keep);
          return;
        }
        onKey({ name: 'paste', text: (pasted + input.slice(0, end)).replace(/\r\n?/g, '\n') });
        pasted = null;
        input = input.slice(end + PASTE_END.length);
        continue;
      }
      if (input.startsWith(PASTE_START)) {
        pasted = '';
        input = input.slice(PASTE_START.length);
        continue;
      }
      if (/^\x1b\[[0-9;]*$/.test(input) && input.length > 1) {
        carry = input;
        return;
      }
      const [key, length] = parseKey(input);
      input = input.slice(length);
      if (key) onKey(key);
    }
  };
}

function parseKey(input) {
  const first = input[0];

  if (first === '\x1b') {
    if (input.length === 1) return [{ name: 'escape' }, 1];

    const csi = input.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
    if (csi) {
      const numbers = csi[1].split(';').map(Number);
      const name = csi[2] === '~' ? TILDE_KEYS[numbers[0]] : CSI_KEYS[csi[2]];
      return [name ? withModifiers(name, (numbers[1] || 1) - 1) : null, csi[0].length];
    }
    const ss3 = input.match(/^\x1bO([A-Za-z])/);
    if (ss3) return [CSI_KEYS[ss3[1]] ? { name: CSI_KEYS[ss3[1]] } : null, 3];

    // Option + 键：Mac 终端里 Option+←/→ 常常发 ESC b / ESC f。
    const next = input[1];
    if (next === '\x1b') return [{ name: 'escape' }, 1];
    if (next === '\x7f' || next === '\b') return [{ name: 'backspace', alt: true }, 2];
    if (next === 'b') return [{ name: 'left', alt: true }, 2];
    if (next === 'f') return [{ name: 'right', alt: true }, 2];
    if (next === '\r') return [{ name: 'enter', alt: true }, 2];
    return [{ name: next, alt: true }, 2];
  }

  if (first === '\r' || first === '\n') return [{ name: 'enter' }, input.startsWith('\r\n') ? 2 : 1];
  if (first === '\x7f' || first === '\b') return [{ name: 'backspace' }, 1];
  if (first === '\t') return [{ name: 'tab' }, 1];

  const code = first.charCodeAt(0);
  if (code < 32) return [{ name: String.fromCharCode(code + 96), ctrl: true }, 1];

  const text = input.match(/^[^\x00-\x1f\x7f]+/)[0];
  return [{ name: 'text', text }, text.length];
}

function withModifiers(name, modifier) {
  return { name, shift: Boolean(modifier & 1), alt: Boolean(modifier & 2), ctrl: Boolean(modifier & 4) };
}

/* ---------- 屏幕 ---------- */

export class Screen {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.previous = [];
    this.active = false;
  }

  get width() {
    return Math.max(30, this.stdout.columns || 80);
  }

  get height() {
    return Math.max(10, this.stdout.rows || 24);
  }

  start(onKey, onResize) {
    this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', createKeyReader(onKey));
    this.stdin.resume();
    this.stdout.on('resize', () => {
      this.previous = [];
      this.stdout.write('\x1b[2J');
      onResize();
    });
    // 切到备用屏幕（退出后终端恢复原样），开启粘贴模式。
    this.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[2J');
    this.active = true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stdout.write('\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l');
    try {
      this.stdin.setRawMode(false);
    } catch {
      // 终端已经关了。
    }
    this.stdin.pause();
  }

  /** rows 是 paint 画好的每一行；只重画变了的行。cursor 为 null 时隐藏光标。 */
  draw(rows, cursor) {
    let output = '\x1b[?2026h\x1b[?25l\x1b[?7l';
    for (let index = 0; index < this.height; index += 1) {
      const row = rows[index] ?? ' '.repeat(this.width);
      if (this.previous[index] !== row) output += `\x1b[${index + 1};1H\x1b[0m${row}`;
    }
    this.previous = rows.slice(0, this.height);
    output += '\x1b[?7h';
    if (cursor) output += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
    output += '\x1b[?2026l';
    this.stdout.write(output);
  }
}
