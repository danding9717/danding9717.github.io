import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextBuffer, cursorRow, layout, wordCount } from '../../scripts/myblog/editor.mjs';

const at = (buffer) => [buffer.line, buffer.col];

test('插入多行文字，光标停在插入内容的后面', () => {
  const buffer = new TextBuffer('ab');
  buffer.setCursor(0, 1);
  buffer.insert('X\nY');
  assert.deepEqual(buffer.lines, ['aX', 'Yb']);
  assert.deepEqual(at(buffer), [1, 1]);
  buffer.insert('\t');
  assert.equal(buffer.lines[1], 'Y  b');
});

test('退格和删除会合并行，表情和中文按一个字删', () => {
  const buffer = new TextBuffer('第一行\n你好👍🏽');
  buffer.setCursor(1, Infinity);
  assert.equal(buffer.col, 3);
  buffer.backspace();
  assert.equal(buffer.lines[1], '你好');
  buffer.setCursor(1, 0);
  buffer.backspace();
  assert.deepEqual(buffer.lines, ['第一行你好']);
  assert.deepEqual(at(buffer), [0, 3]);
  buffer.deleteForward();
  assert.deepEqual(buffer.lines, ['第一行好']);
  buffer.setCursor(0, Infinity);
  buffer.deleteForward();
  assert.deepEqual(buffer.lines, ['第一行好']);
});

test('连续打字合成一步撤销，换行单独一步，重做能恢复', () => {
  const buffer = new TextBuffer('');
  buffer.insert('a');
  buffer.insert('b');
  buffer.insert('\n');
  buffer.insert('c');
  assert.equal(buffer.text, 'ab\nc');
  buffer.undo();
  assert.equal(buffer.text, 'ab\n');
  buffer.undo();
  assert.equal(buffer.text, 'ab');
  buffer.undo();
  assert.equal(buffer.text, '');
  assert.equal(buffer.undo(), false);
  buffer.redo();
  buffer.redo();
  assert.equal(buffer.text, 'ab\n');
  assert.deepEqual(at(buffer), [1, 0]);
  buffer.insert('x');
  assert.equal(buffer.redo(), false);
});

test('按词移动和删除，中文按词典分词', () => {
  const english = new TextBuffer('hello world');
  english.setCursor(0, Infinity);
  english.wordLeft();
  assert.equal(english.col, 6);
  english.wordLeft();
  assert.equal(english.col, 0);
  english.wordRight();
  assert.equal(english.col, 5);

  const chinese = new TextBuffer('我们今天写文章');
  chinese.setCursor(0, Infinity);
  chinese.wordLeft();
  assert.equal(chinese.col, 5);
  chinese.deleteWordBackward();
  assert.equal(chinese.text, '我们今天文章');
  assert.equal(chinese.col, 4);
});

test('上下移动按屏幕上的折行走，尽量保持在同一列', () => {
  const wrapped = new TextBuffer('abcdefgh');
  wrapped.setCursor(0, 6);
  wrapped.vertical(-1, 4);
  assert.deepEqual(at(wrapped), [0, 2]);
  wrapped.vertical(-1, 4);
  assert.deepEqual(at(wrapped), [0, 0]);

  // 中文占两格：「界」后面在第二行第 2 格，往上是「你」后面。
  const wide = new TextBuffer('你好世界abc');
  wide.setCursor(0, 4);
  wide.vertical(-1, 6);
  assert.deepEqual(at(wide), [0, 1]);

  const lines = new TextBuffer('abcdef\nab\nabcdef');
  lines.setCursor(0, 5);
  lines.vertical(1, 80);
  assert.deepEqual(at(lines), [1, 2]);
  lines.vertical(1, 80);
  assert.deepEqual(at(lines), [2, 5]);
  lines.vertical(1, 80);
  assert.deepEqual(at(lines), [2, 6]);
});

test('折行和光标所在的屏幕行', () => {
  const buffer = new TextBuffer('abcdefgh\n');
  const rows = layout(buffer.lines, 4);
  assert.deepEqual(rows, [
    { line: 0, start: 0, end: 4 },
    { line: 0, start: 4, end: 8 },
    { line: 1, start: 0, end: 0 },
  ]);
  buffer.setCursor(0, 4);
  assert.equal(cursorRow(rows, buffer), 1);
  buffer.setCursor(0, 8);
  assert.equal(cursorRow(rows, buffer), 1);
  buffer.setCursor(1, 0);
  assert.equal(cursorRow(rows, buffer), 2);
});

test('改 frontmatter 里的一项', () => {
  const buffer = new TextBuffer('---\ntitle: 旧标题\n---\n\n正文');
  buffer.setCursor(4, 1);
  buffer.setField('title', '新标题');
  assert.equal(buffer.text, '---\ntitle: 新标题\n---\n\n正文');
  buffer.setField('tags', 'AI');
  assert.equal(buffer.text, '---\ntags: AI\ntitle: 新标题\n---\n\n正文');
  assert.deepEqual(at(buffer), [5, 1]);

  const bare = new TextBuffer('正文');
  bare.setField('title', '标题');
  assert.equal(bare.text, '---\ntitle: 标题\n---\n\n正文');
  assert.equal(bare.line, 4);
});

test('光标所在的段落，frontmatter 和空行不算', () => {
  const buffer = new TextBuffer('---\ntitle: x\n---\n\n第一段第一行\n第一段第二行\n\n第二段');
  buffer.setCursor(5, 0);
  assert.deepEqual(buffer.paragraph(), { start: 4, end: 5, text: '第一段第一行\n第一段第二行' });
  buffer.setCursor(1, 0);
  assert.equal(buffer.paragraph(), null);
  buffer.setCursor(6, 0);
  assert.equal(buffer.paragraph(), null);
});

test('[[ 链接补全', () => {
  const buffer = new TextBuffer('见 [[复');
  buffer.setCursor(0, Infinity);
  assert.equal(buffer.linkQuery(), '复');
  buffer.completeLink('复利不只是钱的事');
  assert.equal(buffer.text, '见 [[复利不只是钱的事]]');
  assert.equal(buffer.col, buffer.parts().length);
  assert.equal(buffer.linkQuery(), null);

  const closed = new TextBuffer('[[]] 后面');
  closed.setCursor(0, 2);
  assert.equal(closed.linkQuery(), '');
  closed.completeLink('复利');
  assert.equal(closed.text, '[[复利]] 后面');
  assert.equal(closed.col, 6);
});

test('字数：中文按字，英文按词，不算 frontmatter', () => {
  assert.equal(wordCount('---\ntitle: 很长的标题\n---\n\n中文字 and English words.'), 6);
  assert.equal(wordCount(''), 0);
});
