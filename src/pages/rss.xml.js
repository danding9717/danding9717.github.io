import rss from '@astrojs/rss';
import { getContainerRenderer as getMDXRenderer } from '@astrojs/mdx/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { loadRenderers } from 'astro:container';
import { render } from 'astro:content';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { getExcerpt, getPostUrl, getPublishedPosts } from '../utils/posts';

/** 把正文里以 / 开头的图片和链接补成完整网址，否则在阅读器里打不开。 */
function absolutize(html, site) {
  return html.replace(/(\s(?:src|href)=["'])\/(?!\/)/g, `$1${new URL('/', site).href}`);
}

/** 阅读器用不上多尺寸图片，只留 src，免得 srcset 里的相对地址打不开。 */
function dropSrcset(html) {
  return html.replace(/\s(?:srcset|sizes)=("[^"]*"|'[^']*')/g, '');
}

export async function GET(context) {
  const posts = await getPublishedPosts();
  // 用 Astro 自己把每篇正文渲染一遍，文章里的图片才会换成构建好的地址；.mdx 文章也能输出全文。
  const container = await AstroContainer.create({ renderers: await loadRenderers([getMDXRenderer()]) });

  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site,
    customData: '<language>zh-cn</language>',
    items: await Promise.all(
      posts.map(async (post) => {
        const { Content } = await render(post);
        const html = await container.renderToString(Content);
        return {
          title: post.data.title,
          description: post.data.description || getExcerpt(post) || undefined,
          pubDate: post.data.date,
          link: getPostUrl(post),
          content: absolutize(dropSrcset(html), context.site),
          categories: [...new Set(post.data.tags)],
        };
      }),
    ),
  });
}
