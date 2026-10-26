export const SITE_TITLE = 'Ethan Hu';
export const SITE_DESCRIPTION =
  'A quiet personal blog for technology, business, reading, life, and long-term thinking.';
export const AUTHOR_NAME = 'Ethan Hu';
export const GITHUB_URL = 'https://github.com/danding9717';

// 文章末尾的评论区（giscus）：评论存在本仓库的 GitHub Discussions 里，读者用 GitHub 账号登录后评论。
// 这几个值来自 https://giscus.app/zh-CN 的配置页。categoryId 留空时不显示评论区。
export const GISCUS = {
  repo: 'danding9717/danding9717.github.io',
  repoId: 'R_kgDOSrN57g',
  category: 'Announcements',
  categoryId: 'DIC_kwDOSrN57s4DIciz',
};

// 文章页标题上方的浏览量，计数存在 Vercount（https://www.vercount.one ，不蒜子的替代，免费、不用注册）。
// 每篇按「keyPrefix + 文章地址名（slug）」计数。keyPrefix 故意写死成现在的网址、不跟着 SITE_URL 变，
// 以后换域名浏览量接着累计。endpoint 留空时不显示浏览量。
export const VIEWS = {
  endpoint: 'https://events.vercount.one/api/v2/log',
  keyPrefix: 'https://danding9717.github.io/posts/',
};

export const NAV_LINKS = [
  { href: '/archive/', label: '归档' },
  { href: '/about/', label: '关于' },
  { href: '/now/', label: 'Now' },
];
