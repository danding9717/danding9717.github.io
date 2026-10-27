// 每篇文章的分享图，构建时生成 /og/<地址>.png，文章页的 og:image 指向它。
import type { APIRoute, GetStaticPaths } from 'astro';
import { renderOgImage } from '../../utils/og';
import { formatDate, getPublishedPosts, type Post } from '../../utils/posts';

export const getStaticPaths: GetStaticPaths = async () =>
  (await getPublishedPosts()).map((post) => ({ params: { slug: post.id }, props: { post } }));

export const GET: APIRoute = ({ props }) => {
  const { post } = props as { post: Post };
  const png = renderOgImage({ title: post.data.title, date: formatDate(post.data.date) });
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
