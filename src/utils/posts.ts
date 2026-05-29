import type { CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

export function isPublished(post: Post) {
  return !post.data.draft;
}

export function sortPosts(posts: Post[]) {
  return [...posts].sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );
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
  return `/posts/${post.id}/`;
}

export function getExcerpt(post: Post, maxLength = 320) {
  if (post.data.description) {
    return post.data.description;
  }

  const body = post.body ?? '';
  const plainText = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .trim();

  const paragraphs = plainText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const excerpt = paragraphs.slice(0, 2).join('\n\n');

  return excerpt.length > maxLength
    ? `${excerpt.slice(0, maxLength).trim()}...`
    : excerpt;
}
