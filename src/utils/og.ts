// 文章的分享图：在 X、Telegram、Slack 这类地方分享链接时显示的那张 1200×630 的大图。
// 用 SVG 排好版，再用 resvg 转成 PNG。中文字体用系统里装的：GitHub Actions 上装 Noto Sans CJK（见 deploy.yml），Mac 上是苹方。
import { existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { AUTHOR_NAME, OG_IMAGE } from '../consts';

const { width: OG_WIDTH, height: OG_HEIGHT } = OG_IMAGE;

const PADDING = 80;
const TITLE_WIDTH = OG_WIDTH - PADDING * 2;
/** 标题从大到小试，第一个能在 3 行内排下的字号就用它；最小的字号还排不下时截到 4 行。 */
const TITLE_SIZES = [76, 66, 58, 50];
const MAX_LINES = 3;

// 和 themes.css 的浅色主题一致。
const COLORS = { bg: '#f9f9f7', text: '#2d2d2b', muted: '#6b6b67', name: '#963f23' };
const SANS = `'Noto Sans CJK SC', 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`;
const MONO = `'Noto Sans Mono CJK SC', 'JetBrains Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace`;
// 站标的那把伞，和 public/site-icons/ethan-hu-safari-pinned.svg 是同一个形状（64×64）。
const UMBRELLA = 'M8 28a24 24 0 0 1 48 0H8Zm24 6h8v15a11 11 0 0 1-22 0h8a3 3 0 0 0 6 0V34Z';

// 中文和英文、数字之间加一个很窄的空格，和网页上 text-autospace 的效果一致。
const AUTOSPACE = '\u2006';
const HAN = '\\p{Script=Han}';
const autospace = (text: string) =>
  text
    .replace(new RegExp(`(${HAN})(?=[A-Za-z0-9])`, 'gu'), `$1${AUTOSPACE}`)
    .replace(new RegExp(`([A-Za-z0-9])(?=${HAN})`, 'gu'), `$1${AUTOSPACE}`);

const WIDE = /[⺀-鿿豈-﫿＀-￯　-〿—…“-”]/;
// 这些标点不放在行首，宁可让上一行稍微超出一点。
const NO_LINE_START = /^[，。、；：？！）」』》〉】”’…—,.;:?!)\]]/;

/** 估算宽度（单位是字号）：中文和全角标点一个字宽，英文数字大约一半。 */
function measure(text: string) {
  let width = 0;
  for (const char of text) {
    if (WIDE.test(char)) width += 1;
    else if (char === ' ') width += 0.28;
    else if (char === AUTOSPACE) width += 0.17;
    else if (/[MWmw@]/.test(char)) width += 0.85;
    else if (/[A-Z0-9]/.test(char)) width += 0.62;
    else if (/[ijlI.,:;'!|]/.test(char)) width += 0.3;
    else width += 0.54;
  }
  return width;
}

/** 按字号把标题折成几行：中文逐字断，英文单词不拆开。 */
function wrap(title: string, size: number, maxWidth = TITLE_WIDTH) {
  const tokens = title.match(/[A-Za-z0-9'’._-]+|\s+|./gu) ?? [];
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    const next = line + token;
    if (line && measure(next) * size > maxWidth && !NO_LINE_START.test(token)) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** 行数不变的前提下把行宽收窄，让几行差不多长，免得最后一行只剩一两个字（像 CSS 的 text-wrap: balance）。 */
function balance(title: string, size: number, lines: string[]) {
  let best = lines;
  for (let width = TITLE_WIDTH - 20; width > TITLE_WIDTH / 2; width -= 20) {
    const narrower = wrap(title, size, width);
    if (narrower.length !== lines.length) break;
    best = narrower;
  }
  return best;
}

function layoutTitle(title: string) {
  for (const size of TITLE_SIZES) {
    const lines = wrap(title, size);
    if (lines.length <= MAX_LINES) return { size, lines: balance(title, size, lines) };
  }
  const size = TITLE_SIZES.at(-1)!;
  const lines = wrap(title, size).slice(0, MAX_LINES + 1);
  lines[lines.length - 1] = `${lines.at(-1)!.slice(0, -1)}…`;
  return { size, lines };
}

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function ogSvg({ title, date }: { title: string; date: string }) {
  const { size, lines } = layoutTitle(autospace(title));
  const lineHeight = Math.round(size * 1.35);
  // 标题整块在名字和日期之间垂直居中。
  const blockHeight = lineHeight * (lines.length - 1) + size;
  const top = 150 + (OG_HEIGHT - 150 - 130 - blockHeight) / 2;
  const titleLines = lines
    .map((line, index) => `<tspan x="${PADDING}" y="${Math.round(top + size * 0.88 + index * lineHeight)}">${escapeXml(line)}</tspan>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <rect width="100%" height="100%" fill="${COLORS.bg}"/>
  <text x="${PADDING}" y="${PADDING + 30}" fill="${COLORS.name}" font-family="${MONO}" font-size="36" font-weight="700">${escapeXml(AUTHOR_NAME)}</text>
  <text fill="${COLORS.text}" font-family="${SANS}" font-size="${size}" font-weight="700">${titleLines}</text>
  <text x="${PADDING}" y="${OG_HEIGHT - PADDING}" fill="${COLORS.muted}" font-family="${MONO}" font-size="30">${escapeXml(date)}</text>
  <path transform="translate(${OG_WIDTH - PADDING - 64} ${OG_HEIGHT - PADDING - 54})" fill="${COLORS.text}" d="${UMBRELLA}"/>
</svg>`;
}

// 常见位置的中文和等宽字体，找到了就直接交给 resvg，比每张图都把系统字体扫一遍快。一个中文字体都没找到时才扫系统字体。
const FONT_FILES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/Menlo.ttc',
].filter((file) => existsSync(file));
const FONT_OPTIONS = FONT_FILES.some((file) => !file.includes('Menlo'))
  ? { loadSystemFonts: false, fontFiles: FONT_FILES }
  : { loadSystemFonts: true };

export function renderOgImage(input: { title: string; date: string }) {
  const resvg = new Resvg(ogSvg(input), {
    font: { ...FONT_OPTIONS, defaultFontFamily: 'Noto Sans CJK SC' },
  });
  return resvg.render().asPng();
}
