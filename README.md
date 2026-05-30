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

### 本地写作后台（推荐）

先在项目目录执行一次安装：

```bash
npm run admin:install
```

之后可以在任意目录打开写作后台：

```bash
myblog
```

后台提供几个固定动作：

- `/write`：创建或打开今天的 Markdown，并用 Typora 打开。同一天已有草稿或文章时会直接复用。
- `/write 20260530`：创建或打开指定日期草稿。同一天只允许一篇 blog。
- `/posts`：统一管理草稿、已发布文章和本地回收站。
- `/preview`：打开已经部署的线上博客：`https://danding9717.github.io/`。
- `/publish`：选择草稿发布，自动整理 frontmatter、图片并运行构建检查。
- `/publish 20260529`：直接发布指定日期草稿。
- `/sync`：运行构建检查，提交当前改动并推送到 GitHub。
- `/sync Add note 20260529`：使用自定义提交信息同步。
- `/theme`：按 `light -> dark -> diablo -> light` 顺序切换主题。
- `/theme light`、`/theme dark`、`/theme diablo`：直接切换指定主题。
- `/logs`：查看最近的后台操作记录。
- `/help`：查看命令帮助。
- `/quit`：关闭后台。

键盘操作：按 `/` 调出命令，`Enter` 执行，`↑/↓` 或 `j/k` 移动，`Esc` 返回首页。

在 `/posts` 页面中，按 `Enter` 打开选中的草稿或文章，按 `t` 切换本地回收站。删除内容时需要连续按两次 `d`，文件会移动到 `.blog-trash/`，不会立刻抹掉。

发布完成后，后台会询问是否立即同步到 GitHub。按 `Enter` 同步，按 `Esc` 稍后处理。GitHub Pages 部署需要一点时间；部署完成后用 `/preview` 查看线上版本。未同步的本地内容不会出现在 `/preview` 打开的页面中。

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

后台主题选择会保存在 `~/.config/myblog/config.json`，只对本机 TUI 生效，不会提交到 GitHub。拖动终端边框时，界面会根据窗口尺寸自动切换为标准、紧凑或极小布局；极小布局仍保留命令输入框。

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
