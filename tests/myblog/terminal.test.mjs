import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakLine, charWidth, clip, createKeyReader, graphemes, paint, textWidth, wrap } from '../../scripts/myblog/terminal.mjs';

function keys(...chunks) {
  const events = [];
  const read = createKeyReader((key) => events.push(key));
  for (const chunk of chunks) read(chunk);
  return events;
}

test('字宽：中文、全角标点、表情占两格', () => {
  assert.equal(charWidth('a'), 1);
  assert.equal(charWidth('中'), 2);
  assert.equal(charWidth('，'), 2);
  assert.equal(charWidth('。'), 2);
  assert.equal(charWidth('👍'), 2);
  assert.equal(charWidth('👍🏽'), 2);
  assert.equal(charWidth('é'), 1);
  assert.equal(charWidth('\x07'), 0);
  assert.equal(textWidth('中a👍'), 5);
  assert.deepEqual(graphemes('a👍🏽中'), ['a', '👍🏽', '中']);
});

test('截断不会把一个中文字切成两半', () => {
  assert.equal(clip('中文abc', 3), '中');
  assert.equal(clip('中文abc', 5), '中文a');
  assert.equal(clip('abc', 10), 'abc');
});

test('折行：中文逐字折，英文单词不拆开', () => {
  const english = graphemes('hello world foo');
  assert.deepEqual(
    breakLine(english, 8).map(([start, end]) => english.slice(start, end).join('')),
    ['hello ', 'world ', 'foo'],
  );
  assert.deepEqual(breakLine(graphemes('一二三四五'), 4), [[0, 2], [2, 4], [4, 5]]);
  // 中文里夹着英文时，中文照常逐字折，只有英文单词整体挪到下一行；行尾空格留在上一行。
  assert.deepEqual(wrap('这是 AI 的回答：很长的一段话', 12), ['这是 AI 的回', '答：很长的一', '段话']);
  assert.deepEqual(wrap('中文和 English words', 12), ['中文和 ', 'English ', 'words']);
  assert.deepEqual(breakLine([], 4), [[0, 0]]);
  assert.deepEqual(wrap('ab\n\n中文中文', 4), ['ab', '', '中文', '中文']);
});

test('每一行补齐到屏幕宽度，带颜色', () => {
  assert.equal(paint([['ab', 'bold'], ['c']], 5), '\x1b[1mab\x1b[0mc  ');
  assert.equal(paint([['中文中文', 'plain']], 5), '中文 ');
  assert.equal(paint([], 3), '   ');
});

test('按键：方向键、组合键、Option 移动、Esc', () => {
  assert.deepEqual(keys('\x1b[A', '\x1b[1;5C', '\x1b[1;3D', '\x1bOB'), [
    { name: 'up', shift: false, alt: false, ctrl: false },
    { name: 'right', shift: false, alt: false, ctrl: true },
    { name: 'left', shift: false, alt: true, ctrl: false },
    { name: 'down' },
  ]);
  assert.deepEqual(keys('\x1bb\x1bf\x1b\x7f'), [
    { name: 'left', alt: true },
    { name: 'right', alt: true },
    { name: 'backspace', alt: true },
  ]);
  assert.deepEqual(keys('\x10', '\x0b', '\x13', '\x1a', '\x19'), [
    { name: 'p', ctrl: true },
    { name: 'k', ctrl: true },
    { name: 's', ctrl: true },
    { name: 'z', ctrl: true },
    { name: 'y', ctrl: true },
  ]);
  assert.deepEqual(keys('\x1b'), [{ name: 'escape' }]);
  assert.deepEqual(keys('\x1b[3~', '\x1b[5~'), [
    { name: 'delete', shift: false, alt: false, ctrl: false },
    { name: 'pageup', shift: false, alt: false, ctrl: false },
  ]);
});

test('按键：回车、退格、Tab 和输入法上屏的一整句', () => {
  assert.deepEqual(keys('\r', '\r\n', '\x7f', '\t', '你好，世界'), [
    { name: 'enter' },
    { name: 'enter' },
    { name: 'backspace' },
    { name: 'tab' },
    { name: 'text', text: '你好，世界' },
  ]);
  assert.deepEqual(keys('ab\rc'), [{ name: 'text', text: 'ab' }, { name: 'enter' }, { name: 'text', text: 'c' }]);
});

test('粘贴：整段作为一个事件，结束标记被拆开也能拼上', () => {
  assert.deepEqual(keys('\x1b[200~第一行\r\n第二行\x1b[201~'), [{ name: 'paste', text: '第一行\n第二行' }]);
  assert.deepEqual(keys('\x1b[200~hello\r\nwor', 'ld\x1b[20', '1~x'), [
    { name: 'paste', text: 'hello\nworld' },
    { name: 'text', text: 'x' },
  ]);
  assert.deepEqual(keys('\x1b[', 'B'), [{ name: 'down', shift: false, alt: false, ctrl: false }]);
});
