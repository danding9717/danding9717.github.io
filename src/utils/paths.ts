const baseUrl = import.meta.env.BASE_URL ?? '/';
const basePath = baseUrl === '/' ? '' : baseUrl.replace(/\/$/, '');

export function withBase(path = '/') {
  if (path === '/') {
    return `${basePath}/`;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${basePath}${normalizedPath}`;
}

export function stripBase(pathname: string) {
  if (!basePath) return pathname;
  if (!pathname.startsWith(basePath)) return pathname;

  return pathname.slice(basePath.length) || '/';
}
