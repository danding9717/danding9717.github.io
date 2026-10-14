import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { getPostUrl, getPublishedPosts } from '../utils/posts';

/** 把正文里以 / 开头的图片和链接补成完整网址，否则在阅读器里打不开。 */
function absolutize(html, site) {
  return html.replace(/(\s(?:src|href)=["'])\/(?!\/)/g, `$1${new URL('/', site).href}`);
}

export async function GET(context) {
  const posts = await getPublishedPosts();

  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: getPostUrl(post),
      // .md 文章输出全文；.mdx 文章没有预先渲染好的 HTML，只给导语和原文链接。
      content: post.rendered?.html ? absolutize(post.rendered.html, context.site) : undefined,
      categories: [...new Set(post.data.tags)],
    })),
  });
}
