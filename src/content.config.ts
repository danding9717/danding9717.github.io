import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    // 导语可以不写：页面上就不显示副标题，网页摘要和 RSS 用正文第一段。
    description: z.string().default(''),
    // 可选的短网址，例如 compound → /posts/compound/。发布后不要再改。
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 只能用小写英文、数字和连字符').optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
