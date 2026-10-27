# Ethan Hu

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

整体参考 Naval（nav.al）和 Steph Ango（stephango.com）：一篇只讲一个观点，全站只有一张安静的文章清单。文章用「标签」（frontmatter 里的 `tags`）组织，不再有分类页。

- `/`：学 Naval 的首页。最上面一行外部链接（像 Naval 的「Podcast X Apple Spotify …」，灰色小字后面跟陶土色链接，比如 X、抖音、视频号、GitHub；视频号没有网页，点了弹出二维码图片。改 `src/consts.ts` 的 `HOME_LINKS`），下面最新的 10 篇一篇接一篇（不加框：大标题、摘要和「继续阅读」、日期和阅读时长，整块可点；摘要是导语，没写导语就用正文第一段）。超过 10 篇时最下面有「阅读更多」，点一次在下面接着加载 10 篇，不换页。没有文章时显示空状态。
- `/page/2/`、`/page/3/`……：首页之后的每一批文章，「阅读更多」就是从这里取的；没开 JS 时点「阅读更多」直接打开这一页。每批篇数是 `src/utils/posts.ts` 里的 `PAGE_SIZE`。
- `/posts/<文件名>/`：文章页。标题上方只有日期，下面是副标题（`description`，没写或和正文第一段重复时不显示）。二级标题达到 4 个时在正文上方放一个简单目录。文末依次是「提到这篇的文章」（反向链接）、「相关文章」（按共同标签，最多 3 篇）、「标签：……」、一行「N 分钟阅读 · N 次浏览」（浏览量见下文「浏览量」）和评论区（见下文「评论」）。
- `/tags/`、`/tags/<标签>/`：按标签浏览。以前的 `/topics/` 会跳到 `/tags/`。
- `/now/`：Now 页（最近在做什么），内容直接改 `src/pages/now.md`，改完顺手更新里面的 `updated` 日期。
- `/archive/`：归档（页头第一个链接）。标题下是一条搜索框（Pagefind 全文搜索，有输入时用结果替换列表，按 Esc 清空），下面是精选（带「精选」标签的文章达到 3 篇才显示，最多 5 篇）、标签和按年份排列的全部文章。`/archive/?q=关键词` 可以直接打开搜索结果。
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

### 更新 myblog

不用手动 `git pull`：每次打开 myblog，它会在后台看一眼 GitHub 上有没有新版本，有就同步下来（和发布时一样，草稿不受影响），依赖变了顺带运行 `npm ci`。改到了 myblog 自己的代码，它会在你回到列表、没在发布时自动重启一次，列表下面提示更新了什么。正在写的时候不会打断。

没网、不在 main 分支时不检查。有改过、还没提交的文件（比如改了还没更新上线的文章）时先不更新，列表下面会说明，处理完下次打开会再试。也可以随时运行 `myblog update` 手动更新。

### 列表

打开后是一张列表：上面是草稿，下面是已发布的文章。还没起标题的草稿显示正文的第一句。标题后面是时间：已发布的文章是发布日期（北京时间，比如 `2026-10-20`），草稿是多久前改的。草稿只存在本机的 `src/content/drafts/`，不进 git。

`n` 新建，`Enter` 写或修改，`e` 用其他软件写（见下面「用其他软件写」），`p` 发布选中的草稿，`d` 连按两次删除草稿（挪到 `src/content/drafts/.trash/`），`o` 在浏览器里打开已发布的文章，`q` 退出。已发布的文章改过、还没更新上线的，标着「有改动没上线」，选中按 `p` 更新上线。

### 编辑器

按 `n` 新建，打开就是空白的正文，直接写。标题、导语和标签不在这里写，发布时再填（见下面的「发布」）。

草稿边写边自动保存。快捷键：

- `Ctrl+P` 发布；已发布的文章是更新上线
- `Ctrl+O` 换到其他软件里写（见下面「用其他软件写」）
- `Ctrl+Z` 撤销，`Ctrl+Y` 重做，`Ctrl+S` 立刻保存
- `Option+←/→` 按词移动，`Ctrl+W` 或 `Option+Delete` 删掉前一个词，`Ctrl+A`、`Ctrl+E` 到行首、行尾
- `Esc` 回到列表。一个字都没写的新草稿会直接删掉；已发布的文章改了没更新时，要再按一次 `Esc` 才会放弃修改

链接到别的文章：输入 `[[` 会列出已发布的文章，`↑/↓` 选，`Tab` 插入。也可以手写：

- `[[标题]]`，或者用文章地址，比如 `[[compound]]`
- `[[标题|显示的文字]]`
- `[[标题#小标题]]`：链到那篇文章里的某个小标题

发布时会换成站内链接，被链接的文章末尾会出现在「提到这篇的文章」里。找不到要链接的文章时不会发布，并提示最接近的标题。

图片：把图片文件拖进终端窗口，会插入 `![](图片路径)`。发布时图片复制到 `public/images/<文章地址>/`，路径自动改好。

### 用其他软件写

不想在终端里写，可以交给 Typora 这类软件：在编辑器里按 `Ctrl+O`，或者在列表里选中一篇按 `e`。写新文章就是先按 `n`，再按 `Ctrl+O`。

myblog 会用系统里默认打开 `.md` 文件的软件打开这篇，自己停在一个等待页上，每秒看一次文件：那边保存了，这里的字数和正文跟着更新。写完回到 myblog 按 `Ctrl+P` 发布，后面和平常一样，标题、导语和标签在发布页上填。等待页上按 `Enter` 回到终端里写，`o` 再打开一次，`Esc` 回到列表。

- myblog 只认文件里的内容，那边写完先保存再发布。
- `[[标题]]` 链接在那边照样写。插进去的本机图片（`![](路径)`）发布时会一起复制到网站上。
- 已发布的文章也能这样改，改完按 `Ctrl+P` 更新上线。

用哪个软件：Mac 上就是双击 `.md` 文件时打开的那个。想固定用 Typora，在访达里选中任意一个 `.md` 文件，「显示简介」→「打开方式」选 Typora →「全部更改」。也可以在 `~/.zshrc` 里写一条命令（写好后新开一个终端窗口），myblog 会把文件路径加在后面运行：

```bash
export MYBLOG_EDITOR="open -a Typora"   # Typora
export MYBLOG_EDITOR="code"             # VS Code
export MYBLOG_EDITOR="vim"              # 终端里的编辑器也行，退出后回到 myblog
```

### 发布

在编辑器里按 `Ctrl+P`（列表里按 `p`），打开发布页，填这几项：

- 标题：可选，一句话说出这篇的观点。正文第一行写了 `# 标题` 的话会自动填上。不写就用日期编号，比如 `20261014`，同一天的第二篇是 `20261014-2`，和它的网址一样。
- 导语：可选，一句话，显示在标题下面，也是首页和 RSS 的摘要。不写时页面上不显示副标题，网页摘要和 RSS 用正文第一段。
- 标签：至少选一个。`←/→` 挑，空格选中或取消，也可以直接按数字。选「精选」会放进归档页的精选。要新的标签就在这一行直接打字（或者选最后的「＋ 新标签」），按 `Enter` 加上；用过的标签以后发文章时都会列出来。默认列出的几个写在 `scripts/myblog/blog.mjs` 的 `TAGS` 里。
- 网址：可选，是文章链接的最后一段，只能用小写英文、数字和连字符，比如填 `compound`，文章地址就是 `/posts/compound/`。不填就用日期编号，比如 `/posts/20261014/`。发布后不能再改，评论和别的文章的链接都靠它找到这篇。

`↑/↓` 换一项，`Enter` 到下一项，在最后的「发布」上按 `Enter`；任何时候按 `Ctrl+P` 也行。填过的内容会存进草稿，按 `Esc` 回去接着写，下次打开还在。改已发布的文章时这几项都已经填好，直接按 `Enter` 更新上线。

发布时 myblog 会依次：

1. 同步 GitHub。只从 `main` 分支发布。
2. 检查标签、网址、链接和图片。有问题一次全部列在发布页下面，不发布。
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
- `description` 可以不写：文章页就不显示副标题，首页摘要、网页摘要和 RSS 改用正文第一段（最多 120 个字）。
- `tags` 在站上叫「标签」。标签的地址由名称转成小写、空格换成 `-` 得到，例如 `Daily Notes` 对应 `/tags/daily-notes/`，中文标签直接出现在地址里。
- 文章地址：写了 `slug` 用 `slug`，否则用文件名。两篇文章地址相同时构建会失败。
- `draft: true` 的文章不会出现在网站上。
- 图片放在 `public/images/`，在文章里用 `/images/文件名` 引用。

## 修改博客信息

- 博客名称、作者名和导航菜单在 `src/consts.ts`。
- 浅色、深色两套主题的颜色变量在 `src/styles/themes.css`，代码高亮配色在 `src/styles/code-themes.mjs`，布局和排版在 `src/styles/global.css`。没有手动选过主题的访客会跟随系统的深浅色设置。
- 关于页内容在 `src/pages/about.astro`。

## 评论

文章末尾的评论区用 [giscus](https://giscus.app/zh-CN)：评论存在本仓库的 GitHub Discussions 里（Announcements 分类），每篇文章对应一条讨论，有人发第一条评论时自动创建。读者用 GitHub 账号登录后评论。

- 设置在 `src/consts.ts` 的 `GISCUS`，几个值都来自 giscus.app 的配置页。`categoryId` 留空时不显示评论区。
- 文章按地址名（slug）对应讨论，换域名、改标题都不影响已有评论；改了 slug 会和旧评论断开。
- 评论区的配色在 `public/giscus/light.css` 和 `dark.css`，跟着页面的浅色、深色切换。改了 `src/styles/themes.css` 的颜色时，这两个文件里的对应颜色也要一起改。这两个文件还去掉了评论框的「输入 / 预览」切换，读者打开就是输入框。
- 删除、隐藏评论或锁定讨论，到仓库的 Discussions 页面操作。

第一次启用要在 GitHub 上做三件事：

1. 仓库 Settings → General → Features 里勾选 Discussions。
2. 安装 [giscus 应用](https://github.com/apps/giscus)，只授权本仓库。
3. 打开 [giscus.app](https://giscus.app/zh-CN)，仓库填 `ethanhu9717/ethanhu9717.github.io`，分类选 Announcements，把生成代码里的 `data-category-id` 填进 `GISCUS.categoryId`。

## 浏览量

文章末尾、标签下面那行的「N 次浏览」，像 X 推文下面的查看数。计数存在 [Vercount](https://www.vercount.one/)（不蒜子的替代，免费，不用注册，读者也不用登录）。

- 设置在 `src/consts.ts` 的 `VIEWS`。`endpoint` 留空时不显示浏览量。
- 每篇按「`keyPrefix` + 地址名（slug）」计数。`keyPrefix` 写死成最初的 `https://danding9717.github.io/posts/`，换域名时不要改它，浏览量会接着累计；改了 slug 会从头算。
- 每打开一次文章算一次浏览，作者自己看也算；同一个标签页里刷新不重复算。超过一万显示成「1.2万」。
- 本机预览（localhost）不计数，也不显示浏览量。
- 读者没开 JS、或者 Vercount 打不开、8 秒内没有回应时，这一段不显示，页面其他部分照常。

## GitHub Pages 部署

博客网址只写在根目录的 `site.config.mjs` 里（`SITE_URL`），网站构建和 `myblog`（发布后显示的文章网址）都从这里读取，不要在别处再写一遍。当前是：

```text
https://ethanhu9717.github.io/
```

在仓库 Settings → Pages 将 Source 设为 GitHub Actions。推送到 `main` 后，工作流自动构建并发布。

## 换成自己的域名

以 `example.com` 为例：

1. 把 `site.config.mjs` 里的 `SITE_URL` 改成 `https://example.com`（末尾不加 `/`），提交并推送到 `main`。
2. 在仓库 Settings → Pages → Custom domain 填入 `example.com` 并保存。用 GitHub Actions 部署时不需要 `CNAME` 文件，以这里的设置为准。
3. 在域名商的 DNS 设置里添加记录：
   - 根域名 `example.com`：4 条 A 记录，指向 `185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`。
   - 如果也用 `www.example.com`：一条 CNAME 记录，指向 `ethanhu9717.github.io`。
4. 等 DNS 生效、GitHub 检查通过后，在同一页勾选 Enforce HTTPS。

完成后访问 `ethanhu9717.github.io` 的旧链接会由 GitHub 自动跳到新域名，文章地址不变。RSS、sitemap 和每页的 canonical 链接会在下一次构建时换成新域名。评论区不用改设置，已有评论照常显示；浏览量也不用改设置，接着累计。
