export const defaultWritingStyle = [
  '中文写作。',
  '简洁，有力量。',
  '适合公众号、推文、短文。',
  '少废话，多短句。',
  '观点鲜明，有第一性原理味道。',
  '避免油腻鸡汤。',
  '避免空泛口号。',
  '避免 AI 味。',
].join('\n');

export const writingAssistantActions = [
  {
    command: '/idea',
    commandPaletteLabel: 'Generate Idea',
    help: 'Generate publishable topics',
    id: 'idea',
    label: 'Idea',
    local: false,
    replaceable: false,
    target: 'append',
  },
  {
    command: '/outline',
    commandPaletteLabel: 'Generate Outline',
    help: 'Turn topic into structure',
    id: 'outline',
    label: 'Outline',
    local: false,
    replaceable: false,
    target: 'append',
  },
  {
    command: '/draft',
    commandPaletteLabel: 'Write Draft',
    help: 'Write a full first draft',
    id: 'draft',
    label: 'Draft',
    local: false,
    replaceable: true,
    target: 'document',
  },
  {
    command: '/rewrite',
    commandPaletteLabel: 'Rewrite Selection',
    help: 'Rewrite current paragraph',
    id: 'rewrite',
    label: 'Rewrite',
    local: false,
    replaceable: true,
    target: 'paragraph',
  },
  {
    command: '/polish',
    commandPaletteLabel: 'Polish Selection',
    help: 'Polish current paragraph',
    id: 'polish',
    label: 'Polish',
    local: false,
    replaceable: true,
    target: 'paragraph',
  },
  {
    command: '/expand',
    commandPaletteLabel: 'Expand Selection',
    help: 'Expand current paragraph',
    id: 'expand',
    label: 'Expand',
    local: false,
    replaceable: true,
    target: 'paragraph',
  },
  {
    command: '/compress',
    commandPaletteLabel: 'Compress Selection',
    help: 'Compress current paragraph',
    id: 'compress',
    label: 'Compress',
    local: false,
    replaceable: true,
    target: 'paragraph',
  },
  {
    command: '/title',
    commandPaletteLabel: 'Generate Titles',
    help: 'Generate ten titles',
    id: 'title',
    label: 'Title',
    local: false,
    replaceable: false,
    target: 'append',
  },
  {
    command: '/tweet',
    commandPaletteLabel: 'Tweet Rewrite',
    help: 'Rewrite as Chinese tweet',
    id: 'tweet',
    label: 'Tweet',
    local: false,
    replaceable: false,
    target: 'append',
  },
  {
    command: '/summary',
    commandPaletteLabel: 'Summarize Article',
    help: 'Summarize the article',
    id: 'summary',
    label: 'Summary',
    local: false,
    replaceable: false,
    target: 'append',
  },
  {
    command: '/critic',
    commandPaletteLabel: 'Critique Article',
    help: 'Find weak logic',
    id: 'critic',
    label: 'Critic',
    local: false,
    replaceable: false,
    target: 'append',
  },
  {
    command: '/save',
    commandPaletteLabel: 'Save File',
    help: 'Save current file',
    id: 'save',
    label: 'Save',
    local: true,
    replaceable: false,
    target: 'document',
  },
  {
    command: '/help',
    commandPaletteLabel: 'Help',
    help: 'Show writing commands',
    id: 'help',
    label: 'Help',
    local: true,
    replaceable: false,
    target: 'append',
  },
];

const actionDefinitions = new Map(writingAssistantActions.map((action) => [action.id, action]));
const commandDefinitions = new Map(writingAssistantActions.map((action) => [action.command, action]));

export const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'insertText', 'replacementText', 'titles', 'summary', 'notes', 'target'],
  properties: {
    reply: {
      type: 'string',
      description: 'Main text shown to the writer.',
    },
    insertText: {
      type: ['string', 'null'],
      description: 'Markdown text to append or insert into the editor.',
    },
    replacementText: {
      type: ['string', 'null'],
      description: 'Markdown text to replace the selected text, paragraph, or document body.',
    },
    titles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Title suggestions when relevant.',
    },
    summary: {
      type: ['string', 'null'],
      description: 'Short article summary when relevant.',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Brief implementation or writing notes.',
    },
    target: {
      type: 'string',
      enum: ['document', 'paragraph', 'selection', 'append'],
      description: 'Where the result should be applied.',
    },
  },
};

export function getWritingAssistantAction(actionId) {
  if (actionId === 'ask') return actionDefinitions.get('summary');
  if (actionId === 'continue') return actionDefinitions.get('draft');
  if (actionId === 'metadata') return actionDefinitions.get('title');
  return actionDefinitions.get(actionId) ?? writingAssistantActions[0];
}

export function getWritingAssistantActionByCommand(command) {
  return commandDefinitions.get(String(command ?? '').trim().toLowerCase()) ?? null;
}

export function canReplaceWithAction(actionId) {
  return Boolean(getWritingAssistantAction(actionId).replaceable);
}

export function agentDefinitionForCommand(commandId) {
  const action = getWritingAssistantAction(commandId);
  const definitions = {
    critic: {
      agentName: '审稿 Agent',
      systemPrompt: [
        '你是中文写作工作台里的审稿 Agent。',
        '职责：检查逻辑漏洞、表达冗余、论证薄弱处。',
        '指出问题要具体，给修改方向，不要泛泛评价。',
      ].join('\n'),
    },
    draft: {
      agentName: '初稿 Agent',
      systemPrompt: [
        '你是中文写作工作台里的初稿 Agent。',
        '职责：根据选题或大纲写出完整初稿。',
        '要有清晰观点、自然推进、可直接继续编辑的 Markdown 正文。',
      ].join('\n'),
    },
    expand: editorAgent('扩写当前文本，增加论证、例子和上下文，但不要灌水。'),
    idea: {
      agentName: '选题 Agent',
      systemPrompt: [
        '你是中文写作工作台里的选题 Agent。',
        '职责：从模糊想法中提炼有传播潜力的选题。',
        '选题要有明确冲突、受众和表达角度，避免标题党。',
      ].join('\n'),
    },
    outline: {
      agentName: '大纲 Agent',
      systemPrompt: [
        '你是中文写作工作台里的大纲 Agent。',
        '职责：把选题拆成结构清晰的文章框架。',
        '输出要包含核心观点、分论点、推进顺序和结尾方向。',
      ].join('\n'),
    },
    polish: editorAgent('润色当前文本，让表达更简洁、有力量、少 AI 味。'),
    rewrite: editorAgent('重写当前文本，保留原意，改善结构、节奏和表达。'),
    compress: editorAgent('压缩当前文本，保留信息密度，删掉空话和重复。'),
    summary: {
      agentName: '审稿 Agent',
      systemPrompt: [
        '你是中文写作工作台里的总结 Agent。',
        '职责：总结当前文章的核心观点、结构和可改进处。',
        '总结要短，直接，便于作者继续修改。',
      ].join('\n'),
    },
    title: {
      agentName: '标题 Agent',
      systemPrompt: [
        '你是中文写作工作台里的标题 Agent。',
        '职责：生成更有点击欲望但不低俗的标题。',
        '标题要克制、有信息量、有张力，不制造廉价焦虑。',
      ].join('\n'),
    },
    tweet: editorAgent('把当前内容改写成中文推文，短句、强观点、适合社交平台。'),
  };

  return {
    action,
    ...(definitions[action.id] ?? definitions.summary),
    stylePrompt: `默认写作风格：\n${defaultWritingStyle}`,
  };
}

function editorAgent(task) {
  return {
    agentName: '编辑 Agent',
    systemPrompt: [
      '你是中文写作工作台里的编辑 Agent。',
      `职责：${task}`,
      '不要改变事实，不要加入作者没有提供的具体经历。',
    ].join('\n'),
  };
}

export function buildSystemPrompt(commandId) {
  const definition = agentDefinitionForCommand(commandId);
  return [
    definition.systemPrompt,
    '',
    '你还要服从风格 Agent：',
    definition.stylePrompt,
    '',
    '输出必须是 JSON，字段严格匹配 schema。不要输出 Markdown 代码围栏。',
  ].join('\n');
}

export function buildUserPrompt(request) {
  const action = getWritingAssistantAction(request.command);
  const target = String(request.targetText ?? '').trim();
  const documentText = String(request.documentText ?? '').trim();
  const userInput = String(request.userInput ?? '').trim();
  const styleSamples = String(request.styleSamples ?? '').trim();

  return [
    `命令：${action.command} (${action.help})`,
    `应用目标：${action.target}`,
    '',
    userInput ? `用户输入：\n${userInput}` : '用户输入：无',
    '',
    target ? `当前目标文本：\n${target}` : '当前目标文本：无',
    '',
    documentText ? `当前完整文档：\n${documentText}` : '当前完整文档：空',
    '',
    styleSamples ? `作者历史风格样本：\n${styleSamples}` : '作者历史风格样本：无',
    '',
    commandOutputInstruction(action.id),
  ].join('\n');
}

function commandOutputInstruction(commandId) {
  const instructions = {
    critic:
      '请返回审稿意见。reply 写核心判断，insertText 写可追加到文末的审稿报告，replacementText 为 null，target 为 append。',
    draft:
      '请写完整初稿。reply 写简短说明，replacementText 写完整 Markdown 正文，insertText 可写同样内容，target 为 document。',
    expand:
      '请扩写目标文本。replacementText 写扩写后的文本，reply 写修改说明，target 为 paragraph。',
    idea:
      '请生成 5 个选题。insertText 写 Markdown 结果，包含标题候选、受众、核心冲突、切入角度，target 为 append。',
    outline:
      '请生成文章大纲。insertText 写 Markdown 结果，包含核心观点、文章大纲、论证顺序，target 为 append。',
    polish:
      '请润色目标文本。replacementText 写润色后的文本，reply 写修改说明，target 为 paragraph。',
    rewrite:
      '请重写目标文本。replacementText 写重写后的文本，reply 写修改说明，target 为 paragraph。',
    compress:
      '请压缩目标文本。replacementText 写压缩后的文本，reply 写修改说明，target 为 paragraph。',
    summary:
      '请总结全文。summary 写一句话总结，insertText 写 Markdown 总结，target 为 append。',
    title:
      '请生成 10 个标题。titles 写标题数组，insertText 写 Markdown 标题列表，target 为 append。',
    tweet:
      '请改写为中文推文。insertText 写推文版本，replacementText 为 null，target 为 append。',
  };
  return instructions[commandId] ?? instructions.summary;
}
