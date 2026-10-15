import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { claudeDark, claudeLight } from './src/styles/code-themes.mjs';
import { SITE_URL } from './site.config.mjs';

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  // 两篇文章用了同一个 slug、或两个页面生成同一个网址时，直接让构建失败。
  prerenderConflictBehavior: 'error',
  integrations: [mdx(), sitemap()],
  redirects: {
    // 搜索并入归档页。
    '/search': '/archive/',
    // 「主题」改名「标签」之前的地址。
    '/topics': '/tags/',
  },
  markdown: {
    processor: satteri({
      features: {
        gfm: { footnotes: { label: '注释', backLabel: '返回引用 {reference}' } },
      },
    }),
    syntaxHighlight: 'shiki',
    shikiConfig: {
      themes: {
        light: claudeLight,
        dark: claudeDark,
      },
    },
  },
});
