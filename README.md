# Dan Ding

一个基于 Astro 的极简个人博客，适合长期写作、个人随笔、技术记录和阅读笔记。内容使用 Markdown/MDX 管理，构建结果为静态页面，适合部署到 GitHub Pages。

## 本地开发

```bash
npm install
npm run dev
```

常用命令：

```bash
npm run check
npm run build
npm run preview
```

## 写文章

日常写作入口为 `src/content/drafts/`。可直接用 Obsidian 或 Typora 在此目录写作；发布脚本会自动补全 frontmatter、整理图片并移动至正式文章目录。

### 本地写作后台（推荐）

先在项目目录执行一次安装：

```bash
npm run admin:install
```

安装后可在任意目录启动写作后台：

```bash
myblog
```

常用后台命令：

- `/home`：返回首页。
- `/write [YYYYMMDD]`：创建或打开今天或指定日期的 Markdown，并用默认编辑器打开。同一天已有内容时直接复用。
- `/posts`：阅读和管理草稿、已发布文章及本地回收站。
- `/preview`：打开已经部署的线上博客。
- `/publish [YYYYMMDD]`：选择草稿发布，或直接发布指定日期草稿；自动整理 frontmatter、图片并运行构建检查。
- `/sync [提交信息]`：运行构建检查，提交改动并推送到 GitHub。
- `/theme [light|dark|diablo]`：打开主题选择弹层，或直接切换主题。
- `/models`：选择写作模型，也可以用 `/models <model-id>` 直接设置；`gpt-5.5` 仅适用于 OpenAI API key provider，`grok-4.3` 仅适用于 `XAI_API_KEY` provider。
- `/connect`：选择 `Mock provider`、OpenAI API key、`XAI_API_KEY` 或 Grok CLI 浏览器登录 provider。
- `/settings`：打开设置弹层。也可以直接设置 `editor builtin|typora`、`keymap simple|vim`、`line-numbers on|off`、`auto-save on|off`、`model <id>`、`connection mock|openai|xai|grok-cli`。
- `/logs`、`/help`、`/quit`：查看操作记录、查看帮助或退出后台。

首页默认只显示独立输入框。输入 `/` 或关键词时会出现实时筛选后的紧凑候选；使用 `↑/↓` 或 `j/k` 移动，按 `Enter` 执行，按 `Esc` 关闭。`/theme`、`/publish`、`/models`、`/connect` 和 `/settings` 会继续打开可搜索的二级选择弹层。首页输入 `quit` 也可以退出。

在 `/posts` 页面中，按 `Enter` 直接在后台阅读选中的草稿或文章，按 `e` 使用默认编辑器，按 `i` 强制使用内置编辑器，按 `o` 强制使用 Typora，按 `t` 切换本地回收站。阅读页也支持 `e/i/o`。列表只显示状态、日期和标题，不显示文件路径；拖动终端窗口时，较长的中英文标题会按可用宽度自动换行。删除内容时需要连续按两次 `d`，文件会移动到 `.blog-trash/`，不会立刻抹掉。

内置编辑器会显示完整 Markdown 或 MDX 原文，包括 frontmatter，并按窗口宽度自动换行。默认使用简洁模式：直接输入文字，使用方向键移动，按 `Ctrl+S` 保存、`Ctrl+F` 查找、`Ctrl+Z` 撤销、`Ctrl+Y` 重做、`Esc` 退出。存在未保存内容时，会先询问保存、丢弃或取消。

只要进入内置编辑器，都会进入写作工作台；包括 `/write`、文章列表按 `i`、以及默认编辑器为 `builtin` 时按 `e` 打开的内容。宽屏显示三栏：左侧 drafts/posts 文件区，中间 Markdown 编辑区，右侧 AI Agent 操作区；中等宽度显示编辑区和 AI；窄屏时 AI 仍以覆盖层显示。Typora 模式保持原来的外部打开行为，不显示助手。

助手支持四种 provider。默认可以通过 `/connect` 选择 `Mock provider`，无 API key、无网页登录也能测试 `/idea`、`/outline`、`/draft`、`/polish` 等命令。也可以在 shell 中设置 OpenAI 或 xAI API key，并通过 `/connect` 选择对应 provider：

```bash
export OPENAI_API_KEY="your_openai_api_key"
export XAI_API_KEY="your_xai_api_key"
```

OpenAI provider 默认模型为 `gpt-5.5`，xAI provider 默认模型为 `grok-4.3`。短任务会优先使用 `OPENAI_FAST_MODEL` 或 `XAI_FAST_MODEL`，长文和审稿可用 `OPENAI_DEEP_MODEL` 或 `XAI_DEEP_MODEL` 覆盖。OpenAI 和 xAI 都使用 API key，不读取浏览器登录态；Grok CLI provider 才使用官方 `grok login` 的浏览器登录或 device code。登录完成后会运行 `grok models` 诊断可用模型。博客后台不会读取或保存 Grok CLI 的 token。`/models` 或 Settings 里的 `AI model` 会把模型选择保存到 `~/.config/myblog/config.json`。Grok CLI provider 只展示和使用 `grok models` 返回的模型；`/models grok-4.3` 或 `/models gpt-5.5` 在 Grok CLI provider 下会被拒绝。

右侧 AI Agent 支持 `/idea`、`/outline`、`/draft`、`/rewrite`、`/polish`、`/expand`、`/compress`、`/title`、`/tweet`、`/summary`、`/critic`、`/save`、`/help`。使用 `Ctrl+A` 在正文和助手输入之间切换；助手聚焦时，`←/→` 切换命令，`Enter` 发送请求，`↑/↓` 滚动结果，`Esc` 回到正文。AI 请求支持流式显示，首个 chunk 到达后会立刻显示在右侧结果区；生成中按 `Ctrl+X` 停止。也可以在助手输入框直接输入 `/outline 你的想法` 这类命令。

常用快捷键：`Ctrl+N` 新建草稿，`Ctrl+S` 保存，`Ctrl+O` 打开文件，`Ctrl+K` 打开命令面板，`Ctrl+R` 重写当前段落，`Ctrl+P` 润色当前段落，`Ctrl+T` 生成标题，`Ctrl+X` 停止生成，`Ctrl+Q` 退出编辑器。AI 结果可以用 `Ctrl+R` 应用：编辑类命令替换当前段落，生成类命令插入文末，`/draft` 可替换正文。替换时会保留 frontmatter，并在同目录生成 `.agent-backup-YYYYMMDD-HHMMSS.md` 备份。为了避免覆盖未保存内容，发送 AI 请求前需要先 `Ctrl+S` 保存文件。自动保存内容写入 `src/content/drafts/.autosave/`，最终稿导出到 `exports/`。

在 `/settings` 中切换到 Vim 模式后，内置编辑器会以 Normal 模式打开。支持 `h/j/k/l`、`0/$`、`w/b`、`gg/G`、`i/a/o/O`、`x`、`dd`、`u`、`Ctrl+R`、`/`、`n/N`，以及 `:w`、`:q`、`:wq`、`:q!`。Insert 模式中按 `Esc` 返回 Normal 模式。

阅读页面会隐藏 frontmatter，并轻量展示标题层级、列表、引用、代码块和图片占位。使用 `↑/↓` 或 `j/k` 逐行滚动，使用 `Ctrl+F/Ctrl+B`、`PageUp/PageDown` 或空格翻页，使用 Vim 风格的 `gg` 跳到开头、`G` 跳到结尾；也兼容 `1G` 跳到开头。使用 `n/p` 阅读下一篇或上一篇，按 `Esc` 返回文章列表。阅读位置会在当前后台进程中保留。

发布完成后，后台会询问是否立即同步到 GitHub。按 `Enter` 同步，按 `Esc` 稍后处理；部署完成后可用 `/preview` 查看线上版本。

发布时会自动：

- 为文章生成 frontmatter。
- 从正文第一段提取摘要。
- 把 `20260529.assets/` 里的图片复制到 `public/images/20260529/`。
- 把图片路径改成 `/images/20260529/文件名`。
- 把文章移动到 `src/content/posts/`。
- 运行 `npm run build` 检查网站是否可构建。

上线可以直接在后台执行：

```bash
/sync
```

也可以继续手动执行：

```bash
git add .
git commit -m "Add note 20260529"
git push
```

草稿目录默认被 Git 忽略，避免未完成内容被推到公开仓库。

后台主题和编辑器设置会保存在 `~/.config/myblog/config.json`，只对本机 TUI 生效，不会提交到 GitHub。默认使用内置编辑器、简洁键位和隐藏行号。`light` 使用固定白底，`dark` 继承终端自身背景，`diablo` 使用固定近黑背景和黑金配色；命令候选和二级选择弹层仍使用实色背景以保持可读性。主题切换时，后台也会同步调整终端真实光标颜色；退出后台后恢复终端默认光标。拖动终端边框时，界面会根据窗口尺寸自动切换为标准、紧凑或极小布局；极小布局仍保留命令输入框，内置编辑器缓冲区不会丢失。

如果只想在项目目录里临时启动，也可以用：

```bash
npm run admin
```

### Obsidian / Typora 设置

Obsidian 建议把附件位置设为“当前文件同名 assets 文件夹”。Typora 建议把图片复制到 `${filename}.assets`。这样插入图片后，发布命令会自动整理。

## 手动文章格式

文章放在 `src/content/posts/` 目录中，支持 `.md` 和 `.mdx`。

新文章 frontmatter 示例：

```yaml
---
title: "文章标题"
date: 2026-05-29
category: "Daily"
tags: ["Life", "AI", "Reading"]
description: "文章摘要"
draft: false
---
```

- `draft: true` 的文章不会出现在首页、归档页和 RSS 中。
- 文件名会成为文章地址，例如 `2026-05-29-first-note.md` 会生成 `/posts/2026-05-29-first-note/`。
- 图片可以放在 `public/images/`，在文章里用 `/images/文件名` 引用。

## 修改博客信息

- 博客名称、简介和作者名在 `src/consts.ts`。
- 全站样式在 `src/styles/global.css`。
- 导航在 `src/components/Header.astro`。

## GitHub Pages 部署

项目按 GitHub Pages 用户主页配置。确认 `astro.config.mjs` 中 `site` 为 `https://danding9717.github.io`，并在仓库 Settings → Pages 将 Source 设为 GitHub Actions。推送到 `main` 后，工作流自动构建并发布到：

```text
https://danding9717.github.io/
```

如果以后改为项目站点，例如 `https://yourname.github.io/personal-blog/`，需要在 `astro.config.mjs` 中额外设置：

```js
base: '/personal-blog',
```

并相应调整站内链接或使用 Astro 的 base-aware 路径策略。
