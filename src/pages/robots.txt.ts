// 告诉搜索引擎整站都可以收录，以及网站地图在哪。地址跟着 site.config.mjs 走，换域名不用改。
import type { APIRoute } from 'astro';
import { withBase } from '../utils/paths';

export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL(withBase('/sitemap-index.xml'), site).href;
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
