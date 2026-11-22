import { z } from 'zod';

const sessionRoute =
  /^\/sessions\/([^/]+)(?:\/(trace|artifacts|messages|browser)(?:\/([^/]+))?)?$/u;
const pages = [
  '/sessions',
  '/runs',
  '/artifacts',
  '/extensions',
  '/agents',
  '/settings/models',
  '/settings/layout',
  '/settings/diagnostics',
] as const;
const uuid = z.uuid();

export function workspaceSessionId(path: string): string | undefined {
  const id = sessionRoute.exec(path)?.[1];
  return id && uuid.safeParse(id).success ? id : undefined;
}

export function isWorkspaceLocation(path: string): boolean {
  if (pages.some((page) => page === path)) return true;
  const match = sessionRoute.exec(path);
  if (!match || !uuid.safeParse(match[1]).success) return false;
  const [, , section, item] = match;
  if (section === 'messages') return uuid.safeParse(item).success;
  if (item !== undefined) return section === 'trace' && uuid.safeParse(item).success;
  return true;
}

export const workspaceLocationSchema = z.strictObject({
  path: z.string().max(180).refine(isWorkspaceLocation),
});
