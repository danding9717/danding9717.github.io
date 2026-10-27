export const SITE_TITLE = 'Ethan Hu';
export const SITE_DESCRIPTION =
  'A quiet personal blog for technology, business, reading, life, and long-term thinking.';
export const AUTHOR_NAME = 'Ethan Hu';
export const GITHUB_URL = 'https://github.com/ethanhu9717';

// 文章末尾的评论区（giscus）：评论存在本仓库的 GitHub Discussions 里，读者用 GitHub 账号登录后评论。
// 这几个值来自 https://giscus.app/zh-CN 的配置页。categoryId 留空时不显示评论区。
export const GISCUS = {
  repo: 'ethanhu9717/ethanhu9717.github.io',
  repoId: 'R_kgDOSrN57g',
  category: 'Announcements',
  categoryId: 'DIC_kwDOSrN57s4DIciz',
};

// 文章页标题上方的浏览量，计数存在 Vercount（https://www.vercount.one ，不蒜子的替代，免费、不用注册）。
// 每篇按「keyPrefix + 文章地址名（slug）」计数。keyPrefix 故意写死成最初的网址、不跟着 SITE_URL 变，
// 以后换域名浏览量接着累计。endpoint 留空时不显示浏览量。
export const VIEWS = {
  endpoint: 'https://events.vercount.one/api/v2/log',
  keyPrefix: 'https://danding9717.github.io/posts/',
};

// 首页文章上方的一行链接，学 Naval 的「Podcast X Apple Spotify …」：前面一个灰色小字，后面是陶土色的链接。
// 没有网页地址的（比如视频号）写 qr：点了弹出这张二维码图片，图片放在 public/ 下。links 留空时不显示这一行。
export const HOME_LINKS = {
  label: 'Links',
  links: [
    { label: 'X', href: 'https://x.com/ethanhu9717' },
    // 抖音「Space航天」的主页。用 douyin.com/user/ 的固定地址，不用分享短链（短链会带上手机的设备编号）。
    { label: '抖音', href: 'https://www.douyin.com/user/MS4wLjABAAAAi2ArmZulMTaPMHXZdHdeuSapMJFqAmUSoPaFuqpmyuI' },
    { label: '视频号', qr: '/images/space-channels-qr.jpg', alt: '视频号「Space航天」的二维码' },
    { label: 'GitHub', href: GITHUB_URL },
  ],
};

export const NAV_LINKS = [
  { href: '/archive/', label: '归档' },
  { href: '/about/', label: '关于' },
  { href: '/now/', label: 'Now' },
];
