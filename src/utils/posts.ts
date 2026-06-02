import type { CollectionEntry } from 'astro:content';
import { withBase } from './paths';

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
  return withBase(`/posts/${post.id}/`);
}

export function getExcerpt(post: Post, maxLength = 180) {
  const body = post.body ?? '';
  const omittedContent = '\u0000';
  const plainText = body
    .replace(/```[\s\S]*?```/g, `\n\n${omittedContent}\n\n`)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, `\n\n${omittedContent}\n\n`)
    .replace(/!\[\[[^\]]+\]\]/g, `\n\n${omittedContent}\n\n`)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+.*$/gm, `\n\n${omittedContent}\n\n`)
    .replace(/^>\s?/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .trim();

  const paragraphs = plainText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const firstParagraphIndex = paragraphs.findIndex(
    (paragraph) => paragraph !== omittedContent,
  );
  const firstParagraph = paragraphs[firstParagraphIndex];

  if (!firstParagraph) {
    return post.data.description;
  }

  const excerpt = firstParagraph.slice(0, maxLength).trim();
  const hasMoreContent =
    firstParagraph.length > maxLength || paragraphs.length > firstParagraphIndex + 1;

  return hasMoreContent ? `${excerpt}...` : excerpt;
}
