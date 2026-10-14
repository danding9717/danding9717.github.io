import { getCollection, type CollectionEntry } from 'astro:content';
import { withBase } from './paths';

export type Post = CollectionEntry<'posts'>;

export interface Topic {
  name: string;
  slug: string;
  posts: Post[];
}

/** 挂上这个主题的文章会出现在首页「精选」里。 */
export const FEATURED_TOPIC = '精选';
const FEATURED_MIN = 3;
const FEATURED_MAX = 5;

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

export function getTopicUrl(name: string) {
  return withBase(`/topics/${toSlug(name)}/`);
}

/** 按篇数从多到少排列，「精选」固定放在最后。 */
export function getTopics(posts: Post[]) {
  const topics = new Map<string, Topic>();

  for (const post of posts) {
    for (const name of new Set(post.data.tags)) {
      const slug = toSlug(name);
      if (!slug) continue;
      const topic = topics.get(slug) ?? { name, slug, posts: [] };
      topic.posts.push(post);
      topics.set(slug, topic);
    }
  }

  const isFeatured = (topic: Topic) => topic.name === FEATURED_TOPIC;
  return [...topics.values()].sort(
    (a, b) =>
      Number(isFeatured(a)) - Number(isFeatured(b)) ||
      b.posts.length - a.posts.length ||
      a.name.localeCompare(b.name, 'zh-CN'),
  );
}

/** 带「精选」主题的文章达到 3 篇才显示，最多 5 篇。 */
export function getFeaturedPosts(posts: Post[]) {
  const featured = posts.filter((post) => post.data.tags.includes(FEATURED_TOPIC));
  return featured.length >= FEATURED_MIN ? featured.slice(0, FEATURED_MAX) : [];
}

export function getReadingMinutes(post: Post) {
  const body = (post.body ?? '').replace(/```[\s\S]*?```/g, '');
  const cjkChars = body.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  const words = body.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0;

  return Math.max(1, Math.round(cjkChars / 400 + words / 220));
}

/**
 * 只按共同主题打分（「精选」不算），同分时新的在前。
 * 第三个位置留给匹配文章里最旧的一篇，让旧文章也有机会被看到。
 */
export function getRelatedPosts(post: Post, posts: Post[], limit = 3) {
  const topics = new Set(post.data.tags.filter((tag) => tag !== FEATURED_TOPIC));

  const ranked = posts
    .filter((candidate) => candidate.id !== post.id)
    .map((candidate) => ({
      candidate,
      score: candidate.data.tags.filter((tag) => topics.has(tag)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.data.date.getTime() - a.candidate.data.date.getTime(),
    )
    .map(({ candidate }) => candidate);

  if (ranked.length <= limit) return ranked;

  const picked = ranked.slice(0, limit - 1);
  const oldest = ranked.reduce((a, b) => (b.data.date < a.data.date ? b : a));
  picked.push(picked.includes(oldest) ? ranked[limit - 1] : oldest);
  return picked;
}

/** 正文里指向 /posts/<id>/ 的站内链接。 */
const POST_LINK_PATTERN =
  /(?:\]\(|href=["'])(?:https?:\/\/danding9717\.github\.io)?\/posts\/([^/)"'#?\s]+)\/?/g;

export function getLinkedPostIds(post: Post) {
  const ids = new Set<string>();
  for (const match of (post.body ?? '').matchAll(POST_LINK_PATTERN)) {
    ids.add(decodeURIComponent(match[1]));
  }
  ids.delete(post.id);
  return ids;
}

/**
 * 反向链接：每篇文章被哪些文章提到。
 * 链到不存在的文章时直接报错，让构建失败，避免站内出现断链。
 */
export function getBacklinks(posts: Post[]) {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const backlinks = new Map<string, Post[]>(posts.map((post) => [post.id, []]));

  for (const post of posts) {
    for (const id of getLinkedPostIds(post)) {
      if (!byId.has(id)) {
        throw new Error(`文章 ${post.id} 链接到了不存在的文章 /posts/${id}/`);
      }
      backlinks.get(id)!.push(post);
    }
  }

  return backlinks;
}

function toPlainText(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, '');
}

/**
 * 副标题（description）和正文第一段开头一样时返回 true。
 * myblog 没写 description 时会截取第一段自动生成，这种情况下不再重复显示。
 */
export function descriptionRepeatsBody(post: Post) {
  const description = toPlainText(post.data.description).replace(/(\.\.\.|…)$/, '');
  if (!description) return true;

  const firstParagraph = (post.body ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|!\[|<|---)/.test(block));

  return Boolean(firstParagraph && toPlainText(firstParagraph).startsWith(description));
}
