import path from 'node:path';

export function autosavePathFor({ filePath, projectRoot }) {
  return path.join(
    projectRoot,
    'src/content/drafts/.autosave',
    `${path.basename(filePath)}.autosave.md`,
  );
}

export function exportPathFor({ filePath, projectRoot }) {
  return path.join(projectRoot, 'exports', path.basename(filePath));
}
