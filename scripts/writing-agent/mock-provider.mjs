import {
  collectProviderStream,
  providerEventTypes,
  throwIfAborted,
} from './streaming.mjs';

export class MockProvider {
  async generate(request) {
    return collectProviderStream(this.stream(request));
  }

  async *stream({ context, signal }) {
    const request = context?.request ?? {};
    const command = String(request.command ?? 'summary');
    const source = String(request.targetText || request.userInput || request.documentText || '这个想法');
    const shortSource = source.trim().slice(0, 80) || '普通人应该拥有自己的 AI Agent';
    const result = mockResultForCommand(command, shortSource);
    const text = JSON.stringify(result);
    const displayText = previewTextForResult(result);

    yield { type: providerEventTypes.start };
    yield { type: providerEventTypes.firstToken };

    let textOffset = 0;
    for (const chunk of chunkText(displayText, 28)) {
      throwIfAborted(signal);
      const rawChunk = text.slice(textOffset, textOffset + Math.max(1, Math.ceil(text.length / 10)));
      textOffset += rawChunk.length;
      yield {
        displayText: chunk,
        text: rawChunk,
        type: providerEventTypes.delta,
      };
      await sleep(8, signal);
    }

    if (textOffset < text.length) {
      yield { displayText: '', text: text.slice(textOffset), type: providerEventTypes.delta };
    }

    yield {
      raw: result,
      text,
      type: providerEventTypes.done,
      usage: {
        input_tokens: 0,
        output_tokens: Math.ceil(displayText.length / 2),
        total_tokens: Math.ceil(displayText.length / 2),
      },
    };
  }
}

function previewTextForResult(result) {
  return [
    result.reply,
    result.insertText,
    result.replacementText,
    result.titles?.length ? result.titles.map((title) => `- ${title}`).join('\n') : '',
    result.summary,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function chunkText(text, size) {
  const value = String(text ?? '');
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length ? chunks : [''];
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('AI request was cancelled.'));
      },
      { once: true },
    );
  });
}

function mockResultForCommand(command, source) {
  const base = {
    insertText: null,
    notes: ['MockProvider 本地返回，不依赖真实 API。'],
    replacementText: null,
    reply: 'MockProvider 已生成结果。',
    summary: null,
    target: 'append',
    titles: [],
  };

  if (command === 'idea') {
    return {
      ...base,
      insertText: [
        '# 选题候选',
        '',
        `1. 为什么“${source}”正在变成普通人的新基础设施`,
        `2. 从工具到代理：“${source}”背后的效率跃迁`,
        `3. 普通人如何用 AI Agent 把重复劳动交出去`,
        `4. AI Agent 不是玩具，而是个人生产系统`,
        `5. 先拥有一个小 Agent，再谈宏大的 AI 未来`,
        '',
        '# 核心判断',
        '',
        '真正的变化不在模型多聪明，而在普通人第一次能把一段稳定流程交给软件执行。',
      ].join('\n'),
    };
  }

  if (command === 'outline') {
    return {
      ...base,
      insertText: [
        '# 标题候选',
        '',
        `为什么${source}值得普通人认真对待`,
        '',
        '# 核心观点',
        '',
        'AI Agent 的价值不是替你思考，而是替你稳定执行。',
        '',
        '# 文章大纲',
        '',
        '## 1. 普通人的问题不是缺工具，而是缺连续执行',
        '## 2. Agent 把目标拆成可运行的流程',
        '## 3. 它先从小事开始：整理、提醒、写作、检索',
        '## 4. 真正的门槛是定义任务，而不是追模型',
        '## 5. 结尾：拥有自己的 Agent，就是拥有一个可复利的工作流',
      ].join('\n'),
    };
  }

  if (command === 'draft') {
    const draft = [
      '# 为什么普通人应该拥有自己的 AI Agent',
      '',
      '过去，软件只是工具。',
      '',
      '你点一下，它动一下。你停下来，它也停下来。',
      '',
      'AI Agent 的不同在于，它可以围绕一个目标持续行动。它会理解任务，拆步骤，调用工具，给出结果。',
      '',
      '这件事对普通人很重要。',
      '',
      '因为普通人的稀缺资源不是想法，而是稳定执行。很多计划失败，不是因为方向错了，而是中间有太多重复、琐碎、低价值的动作。',
      '',
      'Agent 的价值，就是把这些动作从你的脑子里搬出去。',
      '',
      '它不必一开始就很宏大。它可以先帮你整理素材，生成提纲，检查文章逻辑，追踪一个项目，或者把每天固定要做的事跑完。',
      '',
      '真正的门槛也不在模型，而在你能不能说清楚任务。',
      '',
      '当你能把一个目标说清楚，Agent 就能把它变成流程。流程能复用，复用会复利。',
      '',
      '普通人拥有自己的 AI Agent，本质上不是赶时髦。',
      '',
      '而是开始拥有一套属于自己的自动化生产系统。',
    ].join('\n');
    return {
      ...base,
      insertText: draft,
      replacementText: draft,
      target: 'document',
    };
  }

  if (['rewrite', 'polish', 'expand', 'compress'].includes(command)) {
    const prefix = {
      compress: '压缩版',
      expand: '扩写版',
      polish: '润色版',
      rewrite: '重写版',
    }[command];
    return {
      ...base,
      replacementText: `${prefix}：${source}\n\n这段话已经处理为更清晰的表达。`,
      reply: `${prefix}已准备好，可替换当前段落。`,
      target: 'paragraph',
    };
  }

  if (command === 'title') {
    const titles = Array.from({ length: 10 }, (_, index) => `标题 ${index + 1}：${source}的真正意义`);
    return {
      ...base,
      insertText: ['# 标题候选', '', ...titles.map((title) => `- ${title}`)].join('\n'),
      titles,
    };
  }

  if (command === 'tweet') {
    return {
      ...base,
      insertText: [
        '普通人需要 AI Agent，不是因为它神奇。',
        '',
        '而是因为它能把重复流程接过去。',
        '',
        '你负责定义目标。',
        '它负责稳定执行。',
        '',
        '这才是个人效率真正开始复利的地方。',
      ].join('\n'),
    };
  }

  if (command === 'critic') {
    return {
      ...base,
      insertText: [
        '# 批判性审稿',
        '',
        '- 核心观点需要更早出现。',
        '- 论证里还缺一个普通人的具体场景。',
        '- 结尾可以更锋利，避免停在泛泛的价值判断。',
      ].join('\n'),
      reply: '已指出主要逻辑风险。',
    };
  }

  return {
    ...base,
    insertText: [
      '# 总结',
      '',
      `这篇文章的核心是：${source}`,
      '',
      '它需要更明确的主张、更少的铺垫，以及一个能落地的例子。',
    ].join('\n'),
    summary: `核心观点：${source}`,
  };
}
