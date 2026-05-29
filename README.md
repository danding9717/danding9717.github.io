# Dan's Notes

一个基于 Astro 的极简个人博客，适合长期写作、个人随笔、技术记录和阅读笔记。内容使用 Markdown / MDX 管理，构建结果是静态页面，适合部署到 GitHub Pages。

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

这个博客的日常写作入口是 `src/content/drafts/`。你可以直接用 Obsidian 或 Typora 打开这个目录写作；发布脚本会负责补全 frontmatter、整理图片、移动到正式文章目录。

每天开始写：

```bash
npm run note:today
```

这会创建或打开当天草稿，例如：

```text
src/content/drafts/20260529.md
src/content/drafts/20260529.assets/
```

正文直接写即可。默认标题就是日期，例如 `20260529`。

查看草稿和已发布文章：

```bash
npm run note:list
```

发布当天草稿：

```bash
npm run note:publish -- 20260529
```

发布时会自动：

- 为文章生成 frontmatter。
- 从正文第一段提取摘要。
- 把 `20260529.assets/` 里的图片复制到 `public/images/20260529/`。
- 把图片路径改成 `/images/20260529/文件名`。
- 把文章移动到 `src/content/posts/`。
- 运行 `npm run build` 检查网站是否可构建。

上线：

```bash
git add .
git commit -m "Add note 20260529"
git push
```

草稿目录默认被 Git 忽略，避免未完成内容被推到公开仓库。

### Obsidian / Typora 设置

Obsidian 建议把附件位置设为“当前文件同名 assets 文件夹”。Typora 建议把图片复制到 `${filename}.assets`。这样插入图片后，发布命令会自动整理。

如果不想自动打开编辑器：

```bash
BLOG_NO_OPEN=1 npm run note:today
```

如果想指定编辑器：

```bash
BLOG_EDITOR=typora npm run note:today
```

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

这个项目按 GitHub Pages 用户主页配置，适合仓库名为：

```text
danding9717.github.io
```

部署前请做两件事：

1. 在 `astro.config.mjs` 中确认 `site` 是 `https://danding9717.github.io`。
2. 在 GitHub 仓库的 Settings -> Pages 中，把 Source 设置为 GitHub Actions。

之后把代码推送到 `main` 分支，`.github/workflows/deploy.yml` 会自动构建并发布。

当前仓库对应的访问地址是：

```text
https://danding9717.github.io/
```

如果以后想部署到项目站点，例如 `https://yourname.github.io/personal-blog/`，需要在 `astro.config.mjs` 中额外设置：

```js
base: '/personal-blog',
```

并相应调整站内链接或用 Astro 的 base-aware 路径策略。
