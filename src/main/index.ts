import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { is } from '@electron-toolkit/utils';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG_FILE, labelChangedFiles, loadReviewLabelConfig } from '@pr-review-tool/review-labeler';
import type { ChangedFile, ChangeType } from '@pr-review-tool/review-labeler';
import type {
  AppState,
  CommentResolution,
  CommentStalenessSnapshot,
  DraftComment,
  ExistingPrComment,
  MockPullRequestDefinition,
  PullRequestAiOptions,
  PullRequestBrief,
  PullRequestBriefCommentStatus,
  PullRequestStory,
  PullRequestSummary,
  ReviewLabelReport,
  RepoStatus,
  SavedRepo
} from '../shared/types';

const execFileAsync = promisify(execFile);
const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
const worktreeSetupPromises = new Map<string, Promise<string>>();
type CodexJobPriority = 'active' | 'background';
type QueuedCodexJob<T> = {
  sequence: number;
  priority: CodexJobPriority;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
let nextCodexJobSequence = 0;
let codexJobRunning = false;
const codexJobQueue: Array<QueuedCodexJob<unknown>> = [];
type CommandName = 'git' | 'gh' | 'codex';
type CommentSnapshotLocation = {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  line?: number;
  startLine?: number;
  endLine?: number;
};

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [process.env.PATH, extraPath].filter(Boolean).join(path.delimiter)
  };
}

function commandExists(command: string): boolean {
  const searchPath = commandEnv().PATH ?? '';
  return searchPath.split(path.delimiter).some((directory) => {
    try {
      accessSync(path.join(directory, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    title: 'PR Review Workspace',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    env: commandEnv(),
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout.trim();
}

async function gitDiff(
  repoPath: string,
  baseRef: string,
  options?: { fullContext?: boolean; nameStatus?: boolean; contextLines?: number }
): Promise<string> {
  const contextLines = options?.fullContext ? 999999 : options?.contextLines ?? 3;
  const args = options?.nameStatus
    ? ['diff', '--name-status', `${baseRef}...HEAD`, '--']
    : ['diff', `--unified=${contextLines}`, `${baseRef}...HEAD`, '--'];

  try {
    return await run('git', args, repoPath);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (!details.includes('no merge base')) throw error;
  }

  const fallbackArgs = options?.nameStatus
    ? ['diff', '--name-status', `${baseRef}..HEAD`, '--']
    : ['diff', `--unified=${contextLines}`, `${baseRef}..HEAD`, '--'];
  return run('git', fallbackArgs, repoPath);
}

async function runWithInput(command: string, args: string[], input: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: commandEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const error = new Error(`Command failed: ${command} ${args.join(' ')}\n${stderr}`);
      Object.assign(error, { stdout, stderr, code });
      reject(error);
    });

    child.stdin.end(input);
  });
}

function enqueueCodexJob<T>(priority: CodexJobPriority, runJob: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    codexJobQueue.push({
      sequence: nextCodexJobSequence,
      priority,
      run: runJob,
      resolve: resolve as (value: unknown) => void,
      reject
    });
    nextCodexJobSequence += 1;
    drainCodexJobQueue();
  });
}

function drainCodexJobQueue(): void {
  if (codexJobRunning) return;
  const nextJobIndex = codexJobQueue.reduce((bestIndex, job, index) => {
    if (bestIndex === -1) return index;
    const best = codexJobQueue[bestIndex];
    if (best.priority !== job.priority) return job.priority === 'active' ? index : bestIndex;
    return job.sequence < best.sequence ? index : bestIndex;
  }, -1);
  if (nextJobIndex === -1) return;

  const [job] = codexJobQueue.splice(nextJobIndex, 1);
  codexJobRunning = true;
  void job
    .run()
    .then(job.resolve, job.reject)
    .finally(() => {
      codexJobRunning = false;
      drainCodexJobQueue();
    });
}

function pullRequestAiPriority(options?: PullRequestAiOptions): CodexJobPriority {
  return options?.background ? 'background' : 'active';
}

function assertCommand(command: CommandName): void {
  if (commandExists(command)) return;

  if (command === 'gh') {
    throw new Error('GitHub CLI is required for v1. Install `gh`, run `gh auth login`, then reopen the repo.');
  }

  if (command === 'codex') {
    throw new Error('Local Codex CLI is required to check comment resolution.');
  }

  throw new Error('Git is required to open and review pull requests.');
}

async function getRepoStatus(repoPath: string): Promise<RepoStatus> {
  assertCommand('git');
  const root = await run('git', ['rev-parse', '--show-toplevel'], repoPath);
  const remoteUrl = await run('git', ['remote', 'get-url', 'origin'], root).catch(() => null);
  const githubReady = commandExists('gh') && await run('gh', ['auth', 'status'], root)
    .then(() => true)
    .catch(() => false);

  return {
    path: repoPath,
    root,
    remoteUrl,
    githubReady
  };
}

function reviewStateDir(repoRoot: string): string {
  return path.join(repoRoot, '.pr-review-tool');
}

function appStatePath(): string {
  return path.join(app.getPath('userData'), 'app-state.json');
}

function demoReposDir(): string {
  return path.join(process.cwd(), '.demo-repos');
}

async function readAppState(): Promise<AppState> {
  const filePath = appStatePath();
  if (!existsSync(filePath)) return {};

  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as AppState;
  } catch {
    return {};
  }
}

async function writeAppState(nextState: AppState): Promise<AppState> {
  const currentState = await readAppState();
  const mergedState = { ...currentState, ...nextState };
  await mkdir(path.dirname(appStatePath()), { recursive: true });
  await writeFile(appStatePath(), `${JSON.stringify(mergedState, null, 2)}\n`);
  return mergedState;
}

function repoDisplayName(repoRoot: string): string {
  return path.basename(repoRoot);
}

async function rememberRepo(repo: RepoStatus): Promise<AppState> {
  const currentState = await readAppState();
  const now = new Date().toISOString();
  const savedRepo: SavedRepo = {
    root: repo.root,
    name: repoDisplayName(repo.root),
    remoteUrl: repo.remoteUrl,
    githubReady: repo.githubReady,
    lastOpenedAt: now
  };
  const existingRepos = currentState.savedRepos ?? [];
  const savedRepos = [savedRepo, ...existingRepos.filter((item) => item.root !== repo.root)];

  return writeAppState({
    lastRepoPath: repo.root,
    savedRepos
  });
}

async function listDemoRepos(): Promise<RepoStatus[]> {
  const directory = demoReposDir();
  if (!existsSync(directory)) return [];

  const entries = await readdir(directory, { withFileTypes: true });
  const repos = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => getRepoStatus(path.join(directory, entry.name)).catch(() => null))
  );

  return repos.filter((repo): repo is RepoStatus => Boolean(repo));
}

function commentsPath(repoRoot: string, prNumber: number): string {
  return path.join(reviewStateDir(repoRoot), `pr-${prNumber}-comments.json`);
}

async function readComments(repoRoot: string, prNumber: number): Promise<DraftComment[]> {
  const filePath = commentsPath(repoRoot, prNumber);
  if (!existsSync(filePath)) return [];
  const comments = JSON.parse(await readFile(filePath, 'utf8')) as DraftComment[];
  return comments.map(normalizeCommentResolution);
}

async function writeComments(repoRoot: string, prNumber: number, comments: DraftComment[]): Promise<void> {
  await mkdir(reviewStateDir(repoRoot), { recursive: true });
  await writeFile(commentsPath(repoRoot, prNumber), `${JSON.stringify(comments, null, 2)}\n`);
}

function worktreePath(repoRoot: string, prNumber: number): string {
  return path.join(reviewStateDir(repoRoot), 'worktrees', `pr-${prNumber}`);
}

function mockPullRequestsPath(repoRoot: string): string {
  return path.join(reviewStateDir(repoRoot), 'mock-prs.json');
}

function pullRequestDiffBase(pr: PullRequestSummary): string {
  return pr.source === 'mock' ? pr.baseRefName : `origin/${pr.baseRefName}`;
}

async function ensurePullRequestWorktree(repoRoot: string, prNumber: number, baseRefName: string): Promise<string> {
  assertCommand('gh');
  assertCommand('git');
  const targetPath = worktreePath(repoRoot, prNumber);
  const prRef = `refs/pr-review-tool/pr-${prNumber}`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await run('git', ['fetch', 'origin', `+${baseRefName}:refs/remotes/origin/${baseRefName}`], repoRoot);
  await run('git', ['fetch', 'origin', `+pull/${prNumber}/head:${prRef}`], repoRoot);

  if (!existsSync(targetPath)) {
    try {
      await run('git', ['worktree', 'add', '--detach', targetPath, prRef], repoRoot);
    } catch (error) {
      if (!isGitWorktreeLockError(error) || !existsSync(targetPath)) throw error;
      await checkoutDetachedWithLockRecovery(targetPath, prRef);
    }
  } else {
    await checkoutDetachedWithLockRecovery(targetPath, prRef);
  }

  return targetPath;
}

async function ensureMockPullRequestWorktree(repoRoot: string, pr: MockPullRequestDefinition): Promise<string> {
  assertCommand('git');
  const targetPath = worktreePath(repoRoot, pr.number);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const headSha = await run('git', ['rev-parse', '--verify', pr.headRefName], repoRoot).catch(() => null);
  if (!headSha) throw new Error(`Mock PR #${pr.number} branch ${pr.headRefName} does not exist.`);

  if (!existsSync(targetPath)) {
    try {
      await run('git', ['worktree', 'add', '--detach', targetPath, pr.headRefName], repoRoot);
    } catch (error) {
      if (!isGitWorktreeLockError(error) || !existsSync(targetPath)) throw error;
      await checkoutDetachedWithLockRecovery(targetPath, pr.headRefName);
    }
  } else {
    await checkoutDetachedWithLockRecovery(targetPath, pr.headRefName);
  }

  return targetPath;
}

async function checkoutDetachedWithLockRecovery(targetPath: string, refName: string): Promise<void> {
  try {
    await run('git', ['checkout', '--detach', refName], targetPath);
  } catch (error) {
    if (!isGitWorktreeLockError(error)) throw error;
    await wait(500);
    try {
      await run('git', ['checkout', '--detach', refName], targetPath);
      return;
    } catch (retryError) {
      if (!isGitWorktreeLockError(retryError)) throw retryError;
    }

    const removed = await removeStaleWorktreeIndexLock(targetPath);
    if (!removed) {
      await wait(500);
    }
    await run('git', ['checkout', '--detach', refName], targetPath);
  }
}

async function removeStaleWorktreeIndexLock(targetPath: string): Promise<boolean> {
  const gitDir = await run('git', ['rev-parse', '--git-dir'], targetPath);
  const lockPath = path.resolve(targetPath, gitDir, 'index.lock');
  if (!existsSync(lockPath)) return false;
  const lockStat = await stat(lockPath);
  if (Date.now() - lockStat.mtimeMs < 10_000) return false;
  await unlink(lockPath);
  return true;
}

function isGitWorktreeLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('index.lock') && message.includes('Another git process seems to be running');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureReviewWorktree(repoRoot: string, pr: PullRequestSummary): Promise<string> {
  const key = `${repoRoot}:${pr.number}`;
  const existing = worktreeSetupPromises.get(key);
  if (existing) return existing;

  const setup = ensureReviewWorktreeUnlocked(repoRoot, pr).finally(() => {
    worktreeSetupPromises.delete(key);
  });
  worktreeSetupPromises.set(key, setup);
  return setup;
}

async function ensureReviewWorktreeUnlocked(repoRoot: string, pr: PullRequestSummary): Promise<string> {
  if (pr.source === 'mock') return ensureMockPullRequestWorktree(repoRoot, pr as MockPullRequestDefinition);
  return ensurePullRequestWorktree(repoRoot, pr.number, pr.baseRefName);
}

async function listMockPullRequests(repoRoot: string): Promise<PullRequestSummary[]> {
  const filePath = mockPullRequestsPath(repoRoot);
  if (!existsSync(filePath)) return [];

  try {
    const rows = JSON.parse(await readFile(filePath, 'utf8')) as MockPullRequestDefinition[];
    return rows.map((row) => ({
      ...row,
      source: 'mock' as const,
      isDraft: row.isDraft ?? false,
      reviewDecision: row.reviewDecision ?? null,
      updatedAt: row.updatedAt ?? new Date().toISOString(),
      url: row.url || `mock://pull/${row.number}`
    }));
  } catch {
    return [];
  }
}

async function listPullRequests(repoRoot: string): Promise<PullRequestSummary[]> {
  const mockPullRequests = await listMockPullRequests(repoRoot);
  if (!commandExists('gh')) return mockPullRequests;

  const json = await run(
    'gh',
    [
      'pr',
      'list',
      '--json',
      'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,updatedAt,url',
      '--limit',
      '100'
    ],
    repoRoot
  ).catch(() => '[]');

  const rows = JSON.parse(json) as Array<
    Omit<PullRequestSummary, 'author'> & { author: { login: string } | null }
  >;

  const githubPullRequests = rows.map((row) => ({
    ...row,
    author: row.author?.login ?? 'unknown',
    source: 'github' as const
  }));

  return [...mockPullRequests, ...githubPullRequests];
}

function changeTypeFromGitStatus(status: string): ChangeType {
  const code = status[0];

  if (code === 'A') return 'added';
  if (code === 'M') return 'modified';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  if (code === 'T') return 'typechanged';
  return 'unknown';
}

function parseChangedFilesNameStatus(output: string): ChangedFile[] {
  if (!output.trim()) return [];

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, firstPath, secondPath] = line.split('\t');
      return {
        path: secondPath ?? firstPath,
        changeType: changeTypeFromGitStatus(status)
      };
    })
    .filter((file) => Boolean(file.path));
}

async function getReviewLabels(repoRoot: string, prNumber: number): Promise<ReviewLabelReport> {
  const pr = await getPullRequestSummary(repoRoot, prNumber);
  if (!pr) throw new Error(`Could not find PR #${prNumber}`);

  const targetPath = await ensureReviewWorktree(repoRoot, pr);
  const configPath = path.join(targetPath, DEFAULT_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      configPath: null,
      definitions: [],
      labels: [],
      files: []
    };
  }

  const nameStatus = await gitDiff(targetPath, pullRequestDiffBase(pr), { nameStatus: true });
  const changedFiles = parseChangedFilesNameStatus(nameStatus);
  const config = await loadReviewLabelConfig(configPath);
  const report = labelChangedFiles(config, changedFiles);

  return {
    configPath,
    definitions: config.labels,
    labels: report.labels,
    files: report.files
  };
}

function summarizeCommentStatuses(comments: DraftComment[]): PullRequestBriefCommentStatus {
  return comments.reduce<PullRequestBriefCommentStatus>(
    (summary, comment) => {
      if (comment.status === 'deleted') return summary;
      const status = comment.resolution?.status ?? 'unchecked';
      summary.total += 1;
      if (status === 'resolved') summary.resolved += 1;
      else if (status === 'still-relevant') summary.stillRelevant += 1;
      else if (status === 'needs-review') summary.needsReview += 1;
      else if (status === 'stale') summary.stale += 1;
      else summary.unchecked += 1;
      return summary;
    },
    {
      total: 0,
      unchecked: 0,
      resolved: 0,
      stillRelevant: 0,
      needsReview: 0,
      stale: 0
    }
  );
}

async function writeCodexPullRequestBriefSchema(): Promise<string> {
  const schemaPath = path.join(app.getPath('userData'), 'pull-request-brief.schema.json');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'codebaseFit', 'reviewFocus', 'risks', 'tags'],
    properties: {
      summary: { type: 'string' },
      codebaseFit: { type: 'string' },
      reviewFocus: {
        type: 'array',
        items: { type: 'string' }
      },
      risks: {
        type: 'array',
        items: { type: 'string' }
      },
      tags: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  };

  await mkdir(path.dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  return schemaPath;
}

async function writeCodexPullRequestStorySchema(): Promise<string> {
  const schemaPath = path.join(app.getPath('userData'), 'pull-request-story.schema.json');
  const diffTargetSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'filePath', 'side', 'line', 'reason'],
    properties: {
      title: { type: 'string' },
      filePath: { type: 'string' },
      side: { type: ['string', 'null'], enum: ['LEFT', 'RIGHT', null] },
      line: { type: ['number', 'null'] },
      reason: { type: 'string' }
    }
  };
  const fragmentSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'filePath', 'language', 'code', 'explanation'],
    properties: {
      title: { type: 'string' },
      filePath: { type: 'string' },
      language: { type: 'string' },
      code: { type: 'string' },
      explanation: { type: 'string' }
    }
  };
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary', 'slides', 'prioritizedReviewPath'],
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'title', 'narrative', 'fragments', 'diffTargets'],
          properties: {
            kind: {
              type: 'string',
              enum: [
                'what-changed',
                'why-it-changed',
                'affected-behavior',
                'code-path',
                'risk',
                'evidence',
                'agent-context',
                'human-inspection'
              ]
            },
            title: { type: 'string' },
            narrative: { type: 'string' },
            fragments: {
              type: 'array',
              items: fragmentSchema
            },
            diffTargets: {
              type: 'array',
              items: diffTargetSchema
            }
          }
        }
      },
      prioritizedReviewPath: {
        type: 'array',
        items: diffTargetSchema
      }
    }
  };

  await mkdir(path.dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  return schemaPath;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated]`;
}

async function readPullRequestStoryGuide(repoRoot: string, targetPath: string): Promise<{ path: string; body: string } | null> {
  const candidates = [
    path.join(targetPath, '.pr-review-tool', 'pr-story-guide.md'),
    path.join(targetPath, '.pr-review-tool', 'review-guide.md'),
    path.join(targetPath, 'PR_REVIEW_GUIDE.md'),
    path.join(repoRoot, '.pr-review-tool', 'pr-story-guide.md'),
    path.join(repoRoot, '.pr-review-tool', 'review-guide.md'),
    path.join(repoRoot, 'PR_REVIEW_GUIDE.md')
  ];
  const guidePath = candidates.find(existsSync);
  if (!guidePath) return null;
  return {
    path: guidePath,
    body: truncateText(await readFile(guidePath, 'utf8'), 12000)
  };
}

async function getPullRequestBrief(repoRoot: string, prNumber: number): Promise<PullRequestBrief> {
  assertCommand('codex');
  const pr = await getPullRequestSummary(repoRoot, prNumber);
  if (!pr) throw new Error(`Could not find PR #${prNumber}`);

  const targetPath = await ensureReviewWorktree(repoRoot, pr);
  const [diff, nameStatus, labels, comments] = await Promise.all([
    gitDiff(targetPath, pullRequestDiffBase(pr), { contextLines: 20 }),
    gitDiff(targetPath, pullRequestDiffBase(pr), { nameStatus: true }),
    getReviewLabels(repoRoot, prNumber),
    readPreparedComments(repoRoot, prNumber)
  ]);
  const schemaPath = await writeCodexPullRequestBriefSchema();
  const outputPath = path.join(app.getPath('userData'), `pull-request-brief-pr-${prNumber}.json`);
  const prompt = `You are preparing a concise PR orientation brief for a lead reviewer.

You may inspect the repository read-only if needed. Do not modify files.

Explain:
- what this PR does
- how it fits in this codebase
- what tags/categories apply
- what the reviewer should focus on

Use the deterministic labels and existing local comment statuses when relevant. Keep the summary practical and concise.
Return only JSON matching the provided schema.

${JSON.stringify(
  {
    pullRequest: pr,
    changedFiles: parseChangedFilesNameStatus(nameStatus),
    deterministicLabels: labels,
    commentStatus: summarizeCommentStatuses(comments),
    existingComments: comments.map((comment) => ({
      id: comment.id,
      location: comment.type === 'summary' ? 'summary' : comment.filePath,
      body: comment.body,
      status: comment.status,
      resolution: comment.resolution
    })),
    diff: truncateText(diff, 35000)
  },
  null,
  2
)}
`;

  await runWithInput(
    'codex',
    ['exec', '--ephemeral', '--cd', targetPath, '--sandbox', 'read-only', '--output-schema', schemaPath, '--output-last-message', outputPath, '-'],
    prompt,
    repoRoot
  );
  const output = await readFile(outputPath, 'utf8');
  const jsonText = output.trim().match(/\{[\s\S]*\}$/)?.[0] ?? output.trim();
  const parsed = JSON.parse(jsonText) as Omit<PullRequestBrief, 'generatedAt' | 'commentStatus'>;

  return {
    generatedAt: new Date().toISOString(),
    summary: parsed.summary,
    codebaseFit: parsed.codebaseFit,
    reviewFocus: Array.isArray(parsed.reviewFocus) ? parsed.reviewFocus : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    commentStatus: summarizeCommentStatuses(comments)
  };
}

async function getPullRequestStory(repoRoot: string, prNumber: number): Promise<PullRequestStory> {
  assertCommand('codex');
  const pr = await getPullRequestSummary(repoRoot, prNumber);
  if (!pr) throw new Error(`Could not find PR #${prNumber}`);

  const targetPath = await ensureReviewWorktree(repoRoot, pr);
  const [diff, nameStatus, labels, draftComments, existingComments, guide] = await Promise.all([
    gitDiff(targetPath, pullRequestDiffBase(pr), { contextLines: 80 }),
    gitDiff(targetPath, pullRequestDiffBase(pr), { nameStatus: true }),
    getReviewLabels(repoRoot, prNumber),
    readPreparedComments(repoRoot, prNumber),
    listExistingComments(repoRoot, prNumber),
    readPullRequestStoryGuide(repoRoot, targetPath)
  ]);
  const schemaPath = await writeCodexPullRequestStorySchema();
  const outputPath = path.join(app.getPath('userData'), `pull-request-story-pr-${prNumber}.json`);
  const prompt = `You are creating a Product Story for a lead reviewer.

Use the supplied diff, deterministic labels, existing PR comments, local draft comments, and optional repo guidance.
Do not modify files.

Product Story is a click-through preflight, not the review itself. It should help the reviewer understand the PR in about 90 seconds, then guide them to the parts that need human judgment.

Return 6-8 slides when possible. Prefer these slide kinds in this order:
1. what-changed
2. why-it-changed
3. affected-behavior
4. code-path
5. risk
6. evidence
7. agent-context
8. human-inspection

Each slide should have one clear narrative point, the smallest useful code fragments, and diff targets for the Open Diff button.
Use code fragments to distinguish exact changed code from narrative. Prefer fragments of 4-20 lines.
Use the agent-context slide for relevant existing review comments, local draft comments, prior comment status, uncertainty, skipped checks, or available local agent context. If there is no useful agent context, say that plainly.
End with a prioritizedReviewPath of exact files/lines a lead should inspect first.
If repo guidance is supplied, follow it and mention the path in your reasoning only through the structured output content, not as a separate note.
Return only JSON matching the provided schema.

${JSON.stringify(
  {
    pullRequest: pr,
    changedFiles: parseChangedFilesNameStatus(nameStatus),
    deterministicLabels: labels,
    commentStatus: summarizeCommentStatuses(draftComments),
    existingComments,
    localDraftComments: draftComments.map((comment) => ({
      id: comment.id,
      location: comment.type === 'summary' ? 'summary' : comment.filePath,
      body: comment.body,
      status: comment.status,
      resolution: comment.resolution
    })),
    repoGuidance: guide,
    diff: truncateText(diff, 60000)
  },
  null,
  2
)}
`;

  await runWithInput(
    'codex',
    ['exec', '--ephemeral', '--cd', targetPath, '--sandbox', 'read-only', '--output-schema', schemaPath, '--output-last-message', outputPath, '-'],
    prompt,
    repoRoot
  );
  const output = await readFile(outputPath, 'utf8');
  const jsonText = output.trim().match(/\{[\s\S]*\}$/)?.[0] ?? output.trim();
  const parsed = JSON.parse(jsonText) as Omit<PullRequestStory, 'generatedAt' | 'repoGuidancePath'>;

  return {
    generatedAt: new Date().toISOString(),
    title: parsed.title,
    summary: parsed.summary,
    repoGuidancePath: guide?.path ?? null,
    slides: Array.isArray(parsed.slides) ? parsed.slides : [],
    prioritizedReviewPath: Array.isArray(parsed.prioritizedReviewPath) ? parsed.prioritizedReviewPath : []
  };
}

async function getGitHubRepository(repoRoot: string): Promise<string> {
  assertCommand('gh');
  return run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], repoRoot);
}

function defaultCommentResolution(): CommentResolution {
  return { status: 'unchecked' };
}

function normalizeCommentResolution(comment: DraftComment): DraftComment {
  if (comment.resolution) return comment;
  return {
    ...comment,
    resolution: defaultCommentResolution()
  };
}

function commentSnapshotLocation(comment: DraftComment): CommentSnapshotLocation | null {
  if (comment.type === 'summary' || !comment.filePath || !comment.side) return null;

  if (comment.type === 'block') {
    if (!comment.startLine || !comment.endLine) return null;
    return {
      filePath: comment.filePath,
      side: comment.side,
      startLine: comment.startLine,
      endLine: comment.endLine
    };
  }

  if (!comment.line) return null;
  return {
    filePath: comment.filePath,
    side: comment.side,
    line: comment.line
  };
}

function snapshotMatchesComment(comment: DraftComment): boolean {
  const location = commentSnapshotLocation(comment);
  const snapshot = comment.stalenessSnapshot;
  if (!location || !snapshot) return false;

  return (
    snapshot.filePath === location.filePath &&
    snapshot.side === location.side &&
    snapshot.line === location.line &&
    snapshot.startLine === location.startLine &&
    snapshot.endLine === location.endLine
  );
}

async function getPullRequestSummary(repoRoot: string, prNumber: number): Promise<PullRequestSummary | null> {
  const prs = await listPullRequests(repoRoot).catch(() => []);
  return prs.find((item) => item.number === prNumber) ?? null;
}

async function captureCommentStalenessSnapshot(
  repoRoot: string,
  comment: DraftComment
): Promise<CommentStalenessSnapshot | undefined> {
  const location = commentSnapshotLocation(comment);
  if (!location) return undefined;

  const pr = await getPullRequestSummary(repoRoot, comment.prNumber);
  const targetPath = worktreePath(repoRoot, comment.prNumber);
  const headSha = existsSync(targetPath) ? await run('git', ['rev-parse', 'HEAD'], targetPath).catch(() => null) : null;
  const baseSha =
    pr && existsSync(targetPath)
      ? await run('git', ['rev-parse', pullRequestDiffBase(pr)], targetPath).catch(() => null)
      : null;
  const commentedSnippet = pr ? await readCommentSnippet(repoRoot, pr, comment) : null;

  return {
    ...location,
    capturedAt: new Date().toISOString(),
    commentedSnippet,
    commitSha: location.side === 'LEFT' ? baseSha : headSha,
    headSha,
    baseSha
  };
}

async function prepareCommentForSave(repoRoot: string, comment: DraftComment): Promise<DraftComment> {
  const normalized = normalizeCommentResolution(comment);
  if (normalized.type === 'summary' || snapshotMatchesComment(normalized)) return normalized;

  const stalenessSnapshot = await captureCommentStalenessSnapshot(repoRoot, normalized);
  if (!stalenessSnapshot) return normalized;

  return {
    ...normalized,
    stalenessSnapshot
  };
}

async function readPreparedComments(repoRoot: string, prNumber: number): Promise<DraftComment[]> {
  const comments = await readComments(repoRoot, prNumber);
  const preparedComments = await Promise.all(comments.map((comment) => prepareCommentForSave(repoRoot, comment)));
  const hasBackfilledMetadata = preparedComments.some((comment, index) => comment !== comments[index]);

  if (hasBackfilledMetadata) {
    await writeComments(repoRoot, prNumber, preparedComments);
  }

  return preparedComments;
}

function codeLanguageForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const languages: Record<string, string> = {
    js: 'js',
    jsx: 'jsx',
    ts: 'ts',
    tsx: 'tsx',
    json: 'json',
    css: 'css',
    scss: 'scss',
    html: 'html',
    md: 'md',
    mjs: 'js',
    cjs: 'js',
    py: 'py',
    rb: 'rb',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    sh: 'sh',
    yml: 'yaml',
    yaml: 'yaml'
  };

  return languages[extension] ?? '';
}

function codeFenceForSnippet(snippet: string): string {
  const longestFence = snippet.match(/`{3,}/g)?.reduce((longest, fence) => Math.max(longest, fence.length), 0) ?? 2;
  return '`'.repeat(Math.max(3, longestFence + 1));
}

async function readCommentSnippet(repoRoot: string, pr: PullRequestSummary, comment: DraftComment): Promise<string | null> {
  if (comment.type === 'summary' || !comment.filePath || !comment.side) return null;

  const startLine = comment.type === 'block' ? comment.startLine : comment.line;
  const endLine = comment.type === 'block' ? comment.endLine : comment.line;
  if (!startLine || !endLine) return null;

  const targetPath = worktreePath(repoRoot, comment.prNumber);
  const revision = comment.side === 'LEFT' ? pullRequestDiffBase(pr) : 'HEAD';
  const fileContents = await run('git', ['show', `${revision}:${comment.filePath}`], targetPath).catch(() => null);
  if (!fileContents) return null;

  return fileContents
    .split(/\r?\n/)
    .slice(startLine - 1, endLine)
    .join('\n');
}

async function writeCodexResolutionSchema(): Promise<string> {
  const schemaPath = path.join(app.getPath('userData'), 'comment-resolution.schema.json');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['comments'],
    properties: {
      comments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'reason'],
          properties: {
            id: { type: 'string' },
            status: {
              type: 'string',
              enum: ['resolved', 'still-relevant', 'needs-review', 'stale']
            },
            reason: { type: 'string' }
          }
        }
      }
    }
  };

  await mkdir(path.dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  return schemaPath;
}

async function buildResolutionPrompt(repoRoot: string, pr: PullRequestSummary, comments: DraftComment[]): Promise<string> {
  const prNumber = pr.number;
  const targetPath = worktreePath(repoRoot, prNumber);
  const headSha = await run('git', ['rev-parse', 'HEAD'], targetPath).catch(() => null);
  const baseSha = await run('git', ['rev-parse', pullRequestDiffBase(pr)], targetPath).catch(() => null);
  const reviewableComments = await Promise.all(
    comments
      .filter((comment) => comment.status !== 'deleted' && comment.type !== 'summary' && comment.body.trim().length > 0)
      .map(async (comment) => {
        const currentSnippet = await readCommentSnippet(repoRoot, pr, comment);
        const originalSnippet = comment.stalenessSnapshot?.commentedSnippet ?? null;
        let deterministicHint = 'needs-review';

        if (!comment.stalenessSnapshot) {
          deterministicHint = 'needs-review: no original snapshot was captured';
        } else if (comment.stalenessSnapshot.headSha === headSha && originalSnippet === currentSnippet) {
          deterministicHint = 'still-relevant: PR head and commented snippet are unchanged';
        } else if (!currentSnippet) {
          deterministicHint = 'stale: the original location no longer resolves cleanly';
        } else if (originalSnippet && originalSnippet !== currentSnippet) {
          deterministicHint = 'changed: commented snippet is different at the original location';
        }

        return {
          id: comment.id,
          body: comment.body,
          type: comment.type,
          filePath: comment.filePath,
          side: comment.side,
          line: comment.line,
          startLine: comment.startLine,
          endLine: comment.endLine,
          originalSnippet,
          currentSnippet,
          deterministicHint,
          capturedHeadSha: comment.stalenessSnapshot?.headSha ?? null,
          currentHeadSha: headSha,
          capturedBaseSha: comment.stalenessSnapshot?.baseSha ?? null,
          currentBaseSha: baseSha
        };
      })
  );

  return `You are checking whether human PR review comments have been addressed in the current code.

Use only the supplied JSON. Do not inspect or modify files.

Classify each comment:
- resolved: the current code appears to address the reviewer comment.
- still-relevant: the issue still appears present and the reviewer should keep it open.
- stale: the comment no longer maps cleanly to the current code/location.
- needs-review: ambiguous; a human should re-check.

Return only JSON that matches the provided schema.

${JSON.stringify({ prNumber, baseRefName: pr.baseRefName, headSha, baseSha, comments: reviewableComments }, null, 2)}
`;
}

function parseCodexResolutionOutput(output: string): Array<{ id: string; status: CommentResolution['status']; reason: string }> {
  const trimmed = output.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}$/)?.[0] ?? trimmed;
  const parsed = JSON.parse(jsonText) as {
    comments?: Array<{ id?: unknown; status?: unknown; reason?: unknown }>;
  };

  if (!Array.isArray(parsed.comments)) {
    throw new Error('Codex resolution output did not include a comments array.');
  }

  const allowedStatuses = new Set<CommentResolution['status']>(['resolved', 'still-relevant', 'needs-review', 'stale']);
  return parsed.comments.map((comment) => {
    if (typeof comment.id !== 'string') throw new Error('Codex resolution output included a comment without an id.');
    if (typeof comment.status !== 'string' || !allowedStatuses.has(comment.status as CommentResolution['status'])) {
      throw new Error(`Codex resolution output included an invalid status for ${comment.id}.`);
    }

    return {
      id: comment.id,
      status: comment.status as CommentResolution['status'],
      reason: typeof comment.reason === 'string' ? comment.reason : ''
    };
  });
}

async function checkCommentResolutions(repoRoot: string, prNumber: number): Promise<DraftComment[]> {
  assertCommand('codex');
  const pr = await getPullRequestSummary(repoRoot, prNumber);
  if (!pr) throw new Error(`Could not find PR #${prNumber}`);

  await ensureReviewWorktree(repoRoot, pr);
  const comments = await readPreparedComments(repoRoot, prNumber);
  const reviewableComments = comments.filter(
    (comment) => comment.status !== 'deleted' && comment.type !== 'summary' && comment.body.trim().length > 0
  );

  if (reviewableComments.length === 0) return comments;

  const schemaPath = await writeCodexResolutionSchema();
  const outputPath = path.join(app.getPath('userData'), `comment-resolution-pr-${prNumber}.json`);
  const prompt = await buildResolutionPrompt(repoRoot, pr, comments);
  await runWithInput(
    'codex',
    ['exec', '--cd', worktreePath(repoRoot, prNumber), '--sandbox', 'read-only', '--output-schema', schemaPath, '--output-last-message', outputPath, '-'],
    prompt,
    repoRoot
  );
  const resolutionOutput = await readFile(outputPath, 'utf8');
  const verdicts = parseCodexResolutionOutput(resolutionOutput);
  const verdictById = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const checkedAt = new Date().toISOString();
  const targetPath = worktreePath(repoRoot, prNumber);
  const currentHeadSha = await run('git', ['rev-parse', 'HEAD'], targetPath).catch(() => null);

  const next = comments.map((comment) => {
    const verdict = verdictById.get(comment.id);
    if (!verdict) return comment;

    return {
      ...comment,
      resolution: {
        status: verdict.status,
        reason: verdict.reason,
        checkedAt,
        lastCheckedHeadSha: currentHeadSha
      },
      updatedAt: checkedAt
    };
  });

  await writeComments(repoRoot, prNumber, next);
  return next;
}

async function formatCommentBody(repoRoot: string, pr: PullRequestSummary, comment: DraftComment): Promise<string> {
  if (comment.type === 'summary') return comment.body;

  const location =
    comment.type === 'block'
      ? `${comment.filePath}:${comment.startLine}-${comment.endLine}`
      : `${comment.filePath}:${comment.line}`;
  const snippet = await readCommentSnippet(repoRoot, pr, comment);

  if (!snippet) return `${location}\n\n${comment.body}`;

  const fence = codeFenceForSnippet(snippet);
  const language = comment.filePath ? codeLanguageForPath(comment.filePath) : '';

  return `${location}\n\n${fence}${language}\n${snippet}\n${fence}\n\n${comment.body}`;
}

async function createGitHubPrComment(
  repoRoot: string,
  prNumber: number,
  pr: PullRequestSummary,
  comment: DraftComment
): Promise<DraftComment> {
  const nameWithOwner = await getGitHubRepository(repoRoot);
  const body = await formatCommentBody(repoRoot, pr, comment);
  const json = await run(
    'gh',
    [
      'api',
      `repos/${nameWithOwner}/issues/${prNumber}/comments`,
      '--method',
      'POST',
      '--field',
      `body=${body}`
    ],
    repoRoot
  );
  const created = JSON.parse(json) as { id: number; html_url: string };

  return {
    ...comment,
    status: 'pushed',
    resolution: comment.resolution ?? defaultCommentResolution(),
    githubCommentId: created.id,
    githubUrl: created.html_url,
    updatedAt: new Date().toISOString()
  };
}

async function deleteGitHubPrComment(repoRoot: string, comment: DraftComment): Promise<void> {
  if (!comment.githubCommentId) return;
  const nameWithOwner = await getGitHubRepository(repoRoot);
  const issueCommentPath = `repos/${nameWithOwner}/issues/comments/${comment.githubCommentId}`;
  const reviewCommentPath = `repos/${nameWithOwner}/pulls/comments/${comment.githubCommentId}`;
  const isNotFound = (error: unknown) => {
    const details = [
      error instanceof Error ? error.message : '',
      typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : '',
      typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : ''
    ].join('\n');

    return details.includes('Not Found') || details.includes('"status":"404"') || details.includes('HTTP 404');
  };

  try {
    await run('gh', ['api', issueCommentPath, '--method', 'DELETE'], repoRoot);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  try {
    await run('gh', ['api', reviewCommentPath, '--method', 'DELETE'], repoRoot);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function listExistingGitHubComments(repoRoot: string, prNumber: number): Promise<ExistingPrComment[]> {
  assertCommand('gh');
  const nameWithOwner = await getGitHubRepository(repoRoot);
  const issueCommentsJson = await run('gh', ['api', `repos/${nameWithOwner}/issues/${prNumber}/comments`], repoRoot).catch(
    () => '[]'
  );
  const reviewCommentsJson = await run('gh', ['api', `repos/${nameWithOwner}/pulls/${prNumber}/comments`], repoRoot).catch(
    () => '[]'
  );
  const issueComments = JSON.parse(issueCommentsJson) as Array<{
    id: number;
    body: string;
    html_url?: string;
    created_at: string;
    updated_at: string;
    user?: { login?: string };
  }>;
  const reviewComments = JSON.parse(reviewCommentsJson) as Array<{
    id: number;
    body: string;
    html_url?: string;
    created_at: string;
    updated_at: string;
    user?: { login?: string };
    path?: string;
    side?: 'LEFT' | 'RIGHT';
    line?: number;
    start_line?: number;
  }>;

  return [
    ...issueComments.map((comment) => ({
      id: `github-issue-${comment.id}`,
      source: 'github' as const,
      author: comment.user?.login ?? 'unknown',
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url,
      type: 'summary' as const
    })),
    ...reviewComments.map((comment) => ({
      id: `github-review-${comment.id}`,
      source: 'github' as const,
      author: comment.user?.login ?? 'unknown',
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url,
      type: comment.start_line ? ('block' as const) : ('line' as const),
      filePath: comment.path,
      side: comment.side,
      line: comment.line,
      startLine: comment.start_line,
      endLine: comment.line
    }))
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function listExistingMockComments(pr: PullRequestSummary): ExistingPrComment[] {
  const now = new Date().toISOString();
  return [
    {
      id: `mock-${pr.number}-summary`,
      source: 'mock',
      author: 'review-lead',
      body: 'Demo note: confirm the label config catches docs, config, and newly added files before syncing comments.',
      createdAt: now,
      updatedAt: now,
      url: `${pr.url}#discussion-summary`,
      type: 'summary'
    },
    {
      id: `mock-${pr.number}-line`,
      source: 'mock',
      author: 'teammate',
      body: 'This is a seeded existing line comment for demoing prior review context.',
      createdAt: now,
      updatedAt: now,
      url: `${pr.url}#discussion-line`,
      type: 'line',
      filePath: 'docs/pr-review-demo/review-checklist.md',
      side: 'RIGHT',
      line: 3
    }
  ];
}

async function listExistingComments(repoRoot: string, prNumber: number): Promise<ExistingPrComment[]> {
  const pr = await getPullRequestSummary(repoRoot, prNumber);
  if (!pr) throw new Error(`Could not find PR #${prNumber}`);
  if (pr.source === 'mock') return listExistingMockComments(pr);
  return listExistingGitHubComments(repoRoot, prNumber);
}

app.whenReady().then(() => {
  ipcMain.handle('app-state:get', () => readAppState());
  ipcMain.handle('app-state:save', (_event, state: AppState) => writeAppState(state));

  ipcMain.handle('repo:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Open Git Repository'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const repo = await getRepoStatus(result.filePaths[0]);
    await rememberRepo(repo);
    await writeAppState({ activePullRequestNumber: undefined });
    return repo;
  });

  ipcMain.handle('repo:open', async (_event, repoPath: string) => {
    const repo = await getRepoStatus(repoPath);
    await rememberRepo(repo);
    return repo;
  });
  ipcMain.handle('demo-repos:list', () => listDemoRepos());
  ipcMain.handle('prs:list', (_event, repoPath: string) => listPullRequests(repoPath));
  ipcMain.handle('labels:get', (_event, repoPath: string, prNumber: number) => getReviewLabels(repoPath, prNumber));
  ipcMain.handle('pr:brief', (_event, repoPath: string, prNumber: number, options?: PullRequestAiOptions) =>
    enqueueCodexJob(pullRequestAiPriority(options), () => getPullRequestBrief(repoPath, prNumber))
  );
  ipcMain.handle('pr:story', (_event, repoPath: string, prNumber: number, options?: PullRequestAiOptions) =>
    enqueueCodexJob(pullRequestAiPriority(options), () => getPullRequestStory(repoPath, prNumber))
  );

  ipcMain.handle('pr:open', async (_event, repoPath: string, prNumber: number, options?: { fullContext?: boolean }) => {
    const prs = await listPullRequests(repoPath);
    const pr = prs.find((item) => item.number === prNumber);
    if (!pr) throw new Error(`Could not find PR #${prNumber}`);

    const targetPath = await ensureReviewWorktree(repoPath, pr);
    const diff = await gitDiff(targetPath, pullRequestDiffBase(pr), { fullContext: options?.fullContext });
    return {
      ...pr,
      worktreePath: targetPath,
      diff
    };
  });

  ipcMain.handle('comments:list', (_event, repoPath: string, prNumber: number) => readPreparedComments(repoPath, prNumber));
  ipcMain.handle('comments:existing', (_event, repoPath: string, prNumber: number) =>
    listExistingComments(repoPath, prNumber)
  );
  ipcMain.handle('comments:check-resolutions', (_event, repoPath: string, prNumber: number) =>
    checkCommentResolutions(repoPath, prNumber)
  );

  ipcMain.handle('comments:save', async (_event, repoPath: string, comment: DraftComment) => {
    const preparedComment = await prepareCommentForSave(repoPath, comment);
    const comments = await readComments(repoPath, preparedComment.prNumber);
    const next = comments.filter((item) => item.id !== preparedComment.id).concat(preparedComment);
    await writeComments(repoPath, preparedComment.prNumber, next);
    return preparedComment;
  });

  ipcMain.handle('comments:delete', async (_event, repoPath: string, prNumber: number, commentId: string) => {
    const comments = await readComments(repoPath, prNumber);
    const next = comments.flatMap((item) => {
      if (item.id !== commentId) return [item];
      if (item.status === 'pushed' || item.status === 'stale') {
        return [
          {
            ...item,
            status: 'deleted' as const,
            resolution: item.resolution ?? defaultCommentResolution(),
            updatedAt: new Date().toISOString()
          }
        ];
      }
      return [];
    });
    await writeComments(repoPath, prNumber, next);
    return next;
  });

  ipcMain.handle('comments:sync', async (_event, repoPath: string, prNumber: number) => {
    const comments = await readComments(repoPath, prNumber);
    const prs = await listPullRequests(repoPath);
    const pr = prs.find((item) => item.number === prNumber);
    if (!pr) throw new Error(`Could not find PR #${prNumber}`);

    await ensureReviewWorktree(repoPath, pr);
    const synced: DraftComment[] = [];

    for (const comment of comments) {
      if (comment.status === 'draft') {
        if (pr.source === 'mock') {
          synced.push({
            ...comment,
            status: 'pushed',
            resolution: comment.resolution ?? defaultCommentResolution(),
            githubCommentId: Date.now(),
            githubUrl: `${pr.url}#comment-${comment.id}`,
            updatedAt: new Date().toISOString()
          });
        } else {
          synced.push(await createGitHubPrComment(repoPath, prNumber, pr, comment));
        }
        continue;
      }

      if (comment.status === 'deleted') {
        if (pr.source !== 'mock') await deleteGitHubPrComment(repoPath, comment);
        continue;
      }

      synced.push(comment);
    }

    await writeComments(repoPath, prNumber, synced);
    return synced;
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
