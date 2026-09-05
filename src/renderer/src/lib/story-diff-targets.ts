import type { PullRequestStoryDiffTarget } from '../../../shared/types';

export type ResolvedStoryDiffTarget = PullRequestStoryDiffTarget & {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
};

function normalizeDiffPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^[ab]\//, '')
    .replace(/^\/+/, '');
}

export function resolveStoryDiffTarget(
  target: PullRequestStoryDiffTarget,
  renderedFilePaths: string[]
): ResolvedStoryDiffTarget {
  const normalizedTarget = normalizeDiffPath(target.filePath);
  const matchedPath =
    renderedFilePaths.find((filePath) => filePath === target.filePath) ??
    renderedFilePaths.find((filePath) => normalizeDiffPath(filePath) === normalizedTarget) ??
    renderedFilePaths.find((filePath) => normalizeDiffPath(filePath).endsWith(`/${normalizedTarget}`)) ??
    target.filePath;

  return {
    ...target,
    filePath: matchedPath,
    side: target.side ?? 'RIGHT'
  };
}

export function storyDiffTargetsMatch(
  first: ResolvedStoryDiffTarget | null,
  second: ResolvedStoryDiffTarget | null
): boolean {
  if (!first || !second) return false;
  return first.filePath === second.filePath && first.side === second.side && first.line === second.line;
}
