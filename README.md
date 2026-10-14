# Dan Hu

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

`npm run build` 会在 Astro 构建完成后运行 Pagefind 生成站内搜索索引，所以归档页的搜索只在构建产物（`npm run preview`）里可用，`npm run dev` 下会提示索引未生成。

## 站点页面

整体参考 Naval（nav.al）和 Steph Ango（stephango.com）：一篇只讲一个观点，全站只有一张安静的文章清单。文章用「主题」（frontmatter 里的 `tags`）组织，不再有分类页。

- `/`：一句自我介绍 → 最新一篇（整张卡片可点）→ 精选（带「精选」主题的文章达到 3 篇才显示，最多 5 篇）→ 主题。全部文章只在 `/archive/` 列出。没有文章时显示空状态。
- `/posts/<文件名>/`：文章页。标题上方是日期和阅读时长，下面是副标题（`description`，和正文第一段重复时不显示）。二级标题达到 4 个时在正文上方放一个简单目录。文末依次是「提到这篇的文章」（反向链接）、「相关文章」（按共同主题，最多 3 篇）、「主题：……」和评论区（见下文「评论」）。
- `/topics/`、`/topics/<主题>/`：按主题浏览。
- `/now/`：Now 页（最近在做什么），内容直接改 `src/pages/now.md`，改完顺手更新里面的 `updated` 日期。
- `/archive/`：归档（页头第一个链接）。标题下是一条搜索框（Pagefind 全文搜索，有输入时用结果替换列表，按 Esc 清空），下面是精选和按年份排列的全部文章。`/archive/?q=关键词` 可以直接打开搜索结果。
- `/about/`、`/rss.xml`（全文输出）、`/sitemap-index.xml`、404 页。
- 全站没有页脚。旧的 `/search/` 跳转到 `/archive/`。RSS 地址写在关于页，也在每页 `<head>` 里供阅读器自动发现。

文章之间的链接在 myblog 里写 `[[标题]]`，发布时换成 `/posts/<文章地址>/`。构建时会检查这些链接，链到不存在的文章会直接报错。

## 写文章

文章在终端里用 `myblog` 写和发布，不用打开别的编辑器，也不用手动敲 git 命令。

第一次在博客目录运行：

```bash
npm install
npm run myblog:install
```

之后在任何目录输入 `myblog` 就能打开。从旧版升级的，`git pull` 之后也要运行一次 `npm run myblog:install`。

### 列表

打开后是一张列表：上面是草稿，下面是已发布的文章。草稿后面会提示还缺什么（标题、导语、主题）。草稿只存在本机的 `src/content/drafts/`，不进 git。

`n` 新建，`Enter` 写或修改，`p` 发布选中的草稿，`d` 连按两次删除草稿（挪到 `src/content/drafts/.trash/`），`o` 在浏览器里打开已发布的文章，`q` 退出。

### 编辑器

新草稿是这样一个骨架，光标停在标题后面：

```markdown
---
title: 
description: 
tags: 
slug: 
---

正文从这里写
```

- `title`：一句话说出这篇的观点。也可以空着，在正文第一行写 `# 标题`。
- `description`：一句导语，显示在标题下面，也是首页和 RSS 的摘要。
- `tags`：主题，至少一个，用逗号隔开，比如 `AI, 生意`。加上「精选」会出现在首页精选。
- `slug`：可选，文章的网址，只能用小写英文、数字和连字符，比如 `compound` 对应 `/posts/compound/`。不写就用发布日期，比如 `/posts/20261014/`，同一天的第二篇是 `20261014-2`。发布后不能再改。

值不用加引号，`date` 也不用写，发布时自动加上。

草稿边写边自动保存。快捷键：

- `Ctrl+P` 发布；已发布的文章是更新上线
- `Ctrl+K` AI 助手
- `Ctrl+Z` 撤销，`Ctrl+Y` 重做，`Ctrl+S` 立刻保存
- `Option+←/→` 按词移动，`Ctrl+W` 或 `Option+Delete` 删掉前一个词，`Ctrl+A`、`Ctrl+E` 到行首、行尾
- `Esc` 回到列表。一个字都没写的新草稿会直接删掉；已发布的文章改了没更新时，要再按一次 `Esc` 才会放弃修改

链接到别的文章：输入 `[[` 会列出已发布的文章，`↑/↓` 选，`Tab` 插入。也可以手写：

- `[[标题]]`，或者用文章地址，比如 `[[compound]]`
- `[[标题|显示的文字]]`
- `[[标题#小标题]]`：链到那篇文章里的某个小标题

发布时会换成站内链接，被链接的文章末尾会出现在「提到这篇的文章」里。找不到要链接的文章时不会发布，并提示最接近的标题。

图片：把图片文件拖进终端窗口，会插入 `![](图片路径)`。发布时图片复制到 `public/images/<文章地址>/`，路径自动改好。

### AI 助手

在编辑器里按 `Ctrl+K`，然后：

- `1` 润色光标所在的这一段，按 `Enter` 替换
- `2` 想 5 个标题，按数字换上
- `3` 审稿：是不是只讲了一个观点、标题有没有说出观点、哪里论证薄弱、哪些句子可以删
- 或者直接写要求，比如「这一段改短一点」，按 `Enter` 发送；结果按 `Enter` 插到这一段后面，按 `r` 替换这一段

换进正文的内容都能用 `Ctrl+Z` 撤回。

AI 要一个 API key：在博客目录照 `.env.example` 建一个 `.env`，写一行 `XAI_API_KEY=…` 或 `OPENAI_API_KEY=…`。都没写、但装了 grok 命令行并运行过 `grok login` 时，用 grok 命令行。

### 发布

在编辑器里按 `Ctrl+P`（列表里按 `p`），看一眼地址、主题和导语，按 `Enter`。myblog 会依次：

1. 同步 GitHub。只从 `main` 分支发布。
2. 检查标题、导语、主题、链接和图片。缺什么一次全部列出来，不发布。
3. 在本地构建一次网站。构建不过就撤回，草稿原样保留。
4. 只提交这篇文章和它的图片，推送到 GitHub。草稿删掉。
5. 等网站更新，上线后显示网址。一般一两分钟，可以先回去写别的。

推送失败时文章已经提交在本地，列表下方会提示，网络好了按 `u` 重新推送。

## 文章格式

文章在 `src/content/posts/`，支持 `.md` 和 `.mdx`。myblog 发布时会整理成这样：

```yaml
---
title: "复利不只是钱的事"
date: 2026-10-14T21:30:00+08:00
description: "一句手写导语，用作副标题和首页摘要"
tags: ["财富", "精选"]
---
```

- `date` 是发布时间（北京时间），同一天的几篇按时间先后排。
- `tags` 在站上叫「主题」。主题的地址由名称转成小写、空格换成 `-` 得到，例如 `Daily Notes` 对应 `/topics/daily-notes/`，中文主题直接出现在地址里。
- 文章地址：写了 `slug` 用 `slug`，否则用文件名。两篇文章地址相同时构建会失败。
- `draft: true` 的文章不会出现在网站上。
- 图片放在 `public/images/`，在文章里用 `/images/文件名` 引用。

## 修改博客信息

- 博客名称、首页介绍语、作者名和导航菜单在 `src/consts.ts`。
- 浅色、深色两套主题的颜色变量在 `src/styles/themes.css`，代码高亮配色在 `src/styles/code-themes.mjs`，布局和排版在 `src/styles/global.css`。没有手动选过主题的访客会跟随系统的深浅色设置。
- 关于页内容在 `src/pages/about.astro`。

## 评论

文章末尾的评论区用 [giscus](https://giscus.app/zh-CN)：评论存在本仓库的 GitHub Discussions 里（Announcements 分类），每篇文章对应一条讨论，有人发第一条评论时自动创建。读者用 GitHub 账号登录后评论。

- 设置在 `src/consts.ts` 的 `GISCUS`，几个值都来自 giscus.app 的配置页。`categoryId` 留空时不显示评论区。
- 文章按地址名（slug）对应讨论，换域名、改标题都不影响已有评论；改了 slug 会和旧评论断开。
- 评论区的配色在 `public/giscus/light.css` 和 `dark.css`，跟着页面的浅色、深色切换。改了 `src/styles/themes.css` 的颜色时，这两个文件里的对应颜色也要一起改。
- 删除、隐藏评论或锁定讨论，到仓库的 Discussions 页面操作。

第一次启用要在 GitHub 上做三件事：

1. 仓库 Settings → General → Features 里勾选 Discussions。
2. 安装 [giscus 应用](https://github.com/apps/giscus)，只授权本仓库。
3. 打开 [giscus.app](https://giscus.app/zh-CN)，仓库填 `danding9717/danding9717.github.io`，分类选 Announcements，把生成代码里的 `data-category-id` 填进 `GISCUS.categoryId`。

## GitHub Pages 部署

博客网址只写在根目录的 `site.config.mjs` 里（`SITE_URL`），网站构建和 `myblog`（发布后显示的文章网址）都从这里读取，不要在别处再写一遍。当前是：

```text
https://danding9717.github.io/
```

在仓库 Settings → Pages 将 Source 设为 GitHub Actions。推送到 `main` 后，工作流自动构建并发布。

## 换成自己的域名

以 `example.com` 为例：

1. 把 `site.config.mjs` 里的 `SITE_URL` 改成 `https://example.com`（末尾不加 `/`），提交并推送到 `main`。
2. 在仓库 Settings → Pages → Custom domain 填入 `example.com` 并保存。用 GitHub Actions 部署时不需要 `CNAME` 文件，以这里的设置为准。
3. 在域名商的 DNS 设置里添加记录：
   - 根域名 `example.com`：4 条 A 记录，指向 `185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`。
   - 如果也用 `www.example.com`：一条 CNAME 记录，指向 `danding9717.github.io`。
4. 等 DNS 生效、GitHub 检查通过后，在同一页勾选 Enforce HTTPS。

完成后访问 `danding9717.github.io` 的旧链接会由 GitHub 自动跳到新域名，文章地址不变。RSS、sitemap 和每页的 canonical 链接会在下一次构建时换成新域名。评论区不用改设置，已有评论照常显示。
