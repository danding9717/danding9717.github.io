// 代码高亮配色，取自 Claude Typora 主题的语法颜色。
function createTheme(name, type, colors) {
  return {
    name,
    type,
    colors: {
      'editor.background': colors.background,
      'editor.foreground': colors.default,
    },
    tokenColors: [
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: colors.comment, fontStyle: 'italic' },
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'storage.modifier',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'variable.language',
        ],
        settings: { foreground: colors.keyword },
      },
      {
        scope: ['string', 'punctuation.definition.string', 'string.template'],
        settings: { foreground: colors.string },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
        settings: { foreground: colors.number },
      },
      {
        scope: ['entity.name.tag', 'entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key'],
        settings: { foreground: colors.tag },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'entity.name.type',
          'entity.name.class',
          'support.class',
          'support.type',
          'markup.heading',
        ],
        settings: { foreground: colors.definition },
      },
      {
        scope: ['variable.parameter', 'variable.other.property', 'variable.other.object.property', 'markup.inline.raw'],
        settings: { foreground: colors.variable },
      },
      {
        scope: ['variable', 'keyword.operator', 'punctuation', 'meta.brace'],
        settings: { foreground: colors.default },
      },
    ],
  };
}

export const claudeLight = createTheme('claude-light', 'light', {
  background: '#ffffff',
  comment: '#6b6b67',
  keyword: '#a83f24',
  string: '#007a3d',
  number: '#8a5a16',
  tag: '#9a3f35',
  default: '#2d2d2b',
  definition: '#365f9d',
  variable: '#815025',
});

export const claudeDark = createTheme('claude-dark', 'dark', {
  background: '#373735',
  comment: '#b2b2b0',
  keyword: '#ff7856',
  string: '#4fd17c',
  number: '#f1b36d',
  tag: '#e49388',
  default: '#f9f9f7',
  definition: '#86a9df',
  variable: '#dca06e',
});
