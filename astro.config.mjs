import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { claudeDark, claudeLight } from './src/styles/code-themes.mjs';

export default defineConfig({
  site: 'https://danding9717.github.io',
  output: 'static',
  integrations: [mdx(), sitemap()],
  markdown: {
    syntaxHighlight: 'shiki',
    shikiConfig: {
      themes: {
        light: claudeLight,
        dark: claudeDark,
      },
    },
  },
});
