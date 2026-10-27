import { getCollection, type CollectionEntry } from 'astro:content';
import { withBase } from './paths';

export type Post = CollectionEntry<'posts'>;

export interface Tag {
  name: string;
  slug: string;
  posts: Post[];
}

/** 挂上这个标签的文章会出现在归档页「精选」里。 */
export const FEATURED_TAG = '精选';
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

/** 日期按北京时间显示：myblog 写进 date 的是带时区的发布时间，而构建网站的机器在 UTC。 */
const TIME_ZONE = 'Asia/Shanghai';

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replaceAll('/', '-');
}

export function getYear(date: Date) {
  return formatDate(date).slice(0, 4);
}

export function getPostUrl(post: Post) {
  return withBase(`/posts/${post.id}/`);
}

export function toSlug(name: string) {
  return name.trim().toLowerCase().replace(/[\s/?#%]+/g, '-');
}

export function getTagUrl(name: string) {
  return withBase(`/tags/${toSlug(name)}/`);
}

/** 按篇数从多到少排列，「精选」固定放在最后。 */
export function getTags(posts: Post[]) {
  const tags = new Map<string, Tag>();

  for (const post of posts) {
    for (const name of new Set(post.data.tags)) {
      const slug = toSlug(name);
      if (!slug) continue;
      const tag = tags.get(slug) ?? { name, slug, posts: [] };
      tag.posts.push(post);
      tags.set(slug, tag);
    }
  }

  const isFeatured = (tag: Tag) => tag.name === FEATURED_TAG;
  return [...tags.values()].sort(
    (a, b) =>
      Number(isFeatured(a)) - Number(isFeatured(b)) ||
      b.posts.length - a.posts.length ||
      a.name.localeCompare(b.name, 'zh-CN'),
  );
}

/** 带「精选」标签的文章达到 3 篇才显示，最多 5 篇。 */
export function getFeaturedPosts(posts: Post[]) {
  const featured = posts.filter((post) => post.data.tags.includes(FEATURED_TAG));
  return featured.length >= FEATURED_MIN ? featured.slice(0, FEATURED_MAX) : [];
}

/** 首页显示的篇数，也是点一次「阅读更多」多出来的篇数。 */
export const PAGE_SIZE = 10;

export interface PostPage {
  page: number;
  posts: Post[];
  /** 下一批的网址；后面没有文章时不填。 */
  next?: string;
}

/** 文章按 PAGE_SIZE 一批：第 1 批在首页，之后依次是 /page/2/、/page/3/……一篇都没有时也返回空的第 1 批。 */
export function paginatePosts(posts: Post[]): PostPage[] {
  const count = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
  return Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    posts: posts.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
    next: index + 1 < count ? withBase(`/page/${index + 2}/`) : undefined,
  }));
}

export function getReadingMinutes(post: Post) {
  const body = (post.body ?? '').replace(/```[\s\S]*?```/g, '');
  const cjkChars = body.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  const words = body.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0;

  return Math.max(1, Math.round(cjkChars / 400 + words / 220));
}

/**
 * 只按共同标签打分（「精选」不算），同分时新的在前。
 * 第三个位置留给匹配文章里最旧的一篇，让旧文章也有机会被看到。
 */
export function getRelatedPosts(post: Post, posts: Post[], limit = 3) {
  const tags = new Set(post.data.tags.filter((tag) => tag !== FEATURED_TAG));

  const ranked = posts
    .filter((candidate) => candidate.id !== post.id)
    .map((candidate) => ({
      candidate,
      score: candidate.data.tags.filter((tag) => tags.has(tag)).length,
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
  /(?:\]\(|href=["'])(?:https?:\/\/ethanhu9717\.github\.io)?\/posts\/([^/)"'#?\s]+)\/?/g;

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

/** 去掉 Markdown 记号后的文字。compact 时连空白也去掉，用来比较两段话。 */
function toPlainText(markdown: string, compact = true) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, compact ? '' : ' ')
    .trim();
}

/** 正文第一段：跳过代码块、注释、小标题、图片和分隔线。 */
function firstParagraph(post: Post) {
  return (post.body ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|!\[|<|---)/.test(block));
}

/** 副标题（description）和正文第一段开头一样时返回 true，这时页面上不重复显示。 */
export function descriptionRepeatsBody(post: Post) {
  const description = toPlainText(post.data.description).replace(/(\.\.\.|…)$/, '');
  if (!description) return true;

  const paragraph = firstParagraph(post);
  return Boolean(paragraph && toPlainText(paragraph).startsWith(description));
}

/** 没写导语时，网页摘要和 RSS 用正文第一段，最多 120 个字。 */
export function getExcerpt(post: Post, limit = 120) {
  const chars = Array.from(toPlainText(firstParagraph(post) ?? '', false));
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}
