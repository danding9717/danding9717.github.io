import { getCollection, type CollectionEntry } from 'astro:content';
import { withBase } from './paths';

export type Post = CollectionEntry<'posts'>;

export interface TaxonomyTerm {
  name: string;
  slug: string;
  posts: Post[];
}

export function isPublished(post: Post) {
  return !post.data.draft;
}

export function sortPosts(posts: Post[]) {
  return [...posts].sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );
}

export async function getPublishedPosts() {
  return sortPosts((await getCollection('posts')).filter(isPublished));
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replaceAll('/', '-');
}

export function getPostUrl(post: Post) {
  return withBase(`/posts/${post.id}/`);
}

export function toSlug(name: string) {
  return name.trim().toLowerCase().replace(/[\s/?#%]+/g, '-');
}

export function getCategoryUrl(name: string) {
  return withBase(`/categories/${toSlug(name)}/`);
}

export function getTagUrl(name: string) {
  return withBase(`/tags/${toSlug(name)}/`);
}

function groupBy(posts: Post[], getNames: (post: Post) => string[]) {
  const terms = new Map<string, TaxonomyTerm>();

  for (const post of posts) {
    for (const name of getNames(post)) {
      const slug = toSlug(name);
      if (!slug) continue;
      const term = terms.get(slug) ?? { name, slug, posts: [] };
      term.posts.push(post);
      terms.set(slug, term);
    }
  }

  return [...terms.values()].sort(
    (a, b) => b.posts.length - a.posts.length || a.name.localeCompare(b.name, 'zh-CN'),
  );
}

export function getCategories(posts: Post[]) {
  return groupBy(posts, (post) => [post.data.category]);
}

export function getTags(posts: Post[]) {
  return groupBy(posts, (post) => [...new Set(post.data.tags)]);
}

export function getReadingMinutes(post: Post) {
  const body = (post.body ?? '').replace(/```[\s\S]*?```/g, '');
  const cjkChars = body.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const words = body.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0;

  return Math.max(1, Math.round(cjkChars / 400 + words / 220));
}

export function getRelatedPosts(post: Post, posts: Post[], limit = 3) {
  const tags = new Set(post.data.tags);

  return posts
    .filter((candidate) => candidate.id !== post.id)
    .map((candidate) => ({
      candidate,
      score:
        candidate.data.tags.filter((tag) => tags.has(tag)).length * 2 +
        (candidate.data.category === post.data.category ? 1 : 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.candidate.data.date.getTime() - a.candidate.data.date.getTime())
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
