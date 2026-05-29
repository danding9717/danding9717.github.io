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
