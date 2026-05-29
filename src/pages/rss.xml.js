import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { getPostUrl, isPublished, sortPosts } from '../utils/posts';

export async function GET(context) {
  const posts = sortPosts((await getCollection('posts')).filter(isPublished));

  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: getPostUrl(post),
      categories: [post.data.category, ...post.data.tags],
    })),
  });
}
