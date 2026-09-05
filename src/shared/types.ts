export type RepoStatus = {
  path: string;
  root: string;
  remoteUrl: string | null;
  githubReady: boolean;
};

export type PullRequestSummary = {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
  updatedAt: string;
  url: string;
  source?: 'github' | 'mock';
};

export type MockPullRequestDefinition = PullRequestSummary & {
  source: 'mock';
};

export type OpenPullRequest = PullRequestSummary & {
  worktreePath: string;
  diff: string;
};

export type CommentResolutionStatus = 'unchecked' | 'stale' | 'needs-review' | 'resolved' | 'still-relevant';

export type CommentStalenessSnapshot = {
  capturedAt: string;
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  line?: number;
  startLine?: number;
  endLine?: number;
  commentedSnippet: string | null;
  commitSha: string | null;
  headSha: string | null;
  baseSha: string | null;
};

export type CommentResolution = {
  status: CommentResolutionStatus;
  checkedAt?: string;
  reason?: string;
  lastCheckedHeadSha?: string | null;
};

export type DraftComment = {
  id: string;
  prNumber: number;
  type: 'line' | 'block' | 'summary';
  filePath?: string;
  side?: 'LEFT' | 'RIGHT';
  line?: number;
  startLine?: number;
  endLine?: number;
  body: string;
  status: 'draft' | 'pushed' | 'stale' | 'deleted';
  createdAt: string;
  updatedAt: string;
  githubCommentId?: number;
  githubUrl?: string;
  stalenessSnapshot?: CommentStalenessSnapshot;
  resolution?: CommentResolution;
};

export type ExistingPrComment = {
  id: string;
  source: 'github' | 'mock';
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url?: string;
  type: 'summary' | 'line' | 'block';
  filePath?: string;
  side?: 'LEFT' | 'RIGHT';
  line?: number;
  startLine?: number;
  endLine?: number;
};

export type AppState = {
  lastRepoPath?: string;
  activePullRequestNumber?: number;
  savedRepos?: SavedRepo[];
  favoritePullRequests?: FavoritePullRequest[];
  settings?: AppSettings;
  theme?: 'light' | 'dark';
  leftSidebarWidth?: number;
  rightSidebarWidth?: number;
  leftSidebarCollapsed?: boolean;
  rightSidebarCollapsed?: boolean;
};

export type SavedRepo = {
  root: string;
  name: string;
  remoteUrl: string | null;
  githubReady: boolean;
  lastOpenedAt: string;
};

export type FavoritePullRequest = {
  repoRoot: string;
  repoName: string;
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
  favoritedAt: string;
};

export type AppSettings = {
  autoOpenLastPullRequest?: boolean;
  generateBriefOnOpen?: boolean;
  generateStoryWithLocalCodex?: boolean;
  checkResolutionWithLocalCodex?: boolean;
  obfuscatePathsAndUrls?: boolean;
  defaultTheme?: 'system' | 'light' | 'dark';
};

export type ReviewChangeType =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechanged'
  | 'unknown';

export type ReviewLabelRule = {
  paths?: string[];
  excludePaths?: string[];
  changeTypes?: ReviewChangeType[];
};

export type ReviewLabelDefinition = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  rules: ReviewLabelRule[];
};

export type ReviewMatchedLabel = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  files: string[];
};

export type ReviewFileLabel = {
  path: string;
  changeType: ReviewChangeType;
  labels: string[];
};

export type ReviewLabelReport = {
  configPath: string | null;
  definitions: ReviewLabelDefinition[];
  labels: ReviewMatchedLabel[];
  files: ReviewFileLabel[];
};

export type PullRequestBriefCommentStatus = {
  total: number;
  unchecked: number;
  resolved: number;
  stillRelevant: number;
  needsReview: number;
  stale: number;
};

export type PullRequestBrief = {
  generatedAt: string;
  summary: string;
  codebaseFit: string;
  reviewFocus: string[];
  risks: string[];
  tags: string[];
  commentStatus: PullRequestBriefCommentStatus;
};

export type PullRequestStoryCodeFragment = {
  title: string;
  filePath: string;
  language: string;
  code: string;
  explanation: string;
};

export type PullRequestStoryDiffTarget = {
  title: string;
  filePath: string;
  side?: 'LEFT' | 'RIGHT';
  line?: number;
  reason: string;
};

export type PullRequestStorySlideKind =
  | 'what-changed'
  | 'why-it-changed'
  | 'affected-behavior'
  | 'code-path'
  | 'risk'
  | 'evidence'
  | 'agent-context'
  | 'human-inspection';

export type PullRequestStorySlide = {
  kind: PullRequestStorySlideKind;
  title: string;
  narrative: string;
  fragments: PullRequestStoryCodeFragment[];
  diffTargets: PullRequestStoryDiffTarget[];
};

export type PullRequestStory = {
  generatedAt: string;
  title: string;
  summary: string;
  repoGuidancePath: string | null;
  slides: PullRequestStorySlide[];
  prioritizedReviewPath: PullRequestStoryDiffTarget[];
};

export type PullRequestAiOptions = {
  background?: boolean;
};

export type ReviewApi = {
  chooseRepo(): Promise<RepoStatus | null>;
  openRepo(path: string): Promise<RepoStatus>;
  listDemoRepos(): Promise<RepoStatus[]>;
  listPullRequests(repoPath: string): Promise<PullRequestSummary[]>;
  openPullRequest(repoPath: string, prNumber: number, options?: { fullContext?: boolean }): Promise<OpenPullRequest>;
  listExistingComments(repoPath: string, prNumber: number): Promise<ExistingPrComment[]>;
  listDraftComments(repoPath: string, prNumber: number): Promise<DraftComment[]>;
  saveDraftComment(repoPath: string, comment: DraftComment): Promise<DraftComment>;
  deleteDraftComment(repoPath: string, prNumber: number, commentId: string): Promise<DraftComment[]>;
  syncDraftComments(repoPath: string, prNumber: number): Promise<DraftComment[]>;
  checkCommentResolutions(repoPath: string, prNumber: number): Promise<DraftComment[]>;
  getReviewLabels(repoPath: string, prNumber: number): Promise<ReviewLabelReport>;
  getPullRequestBrief(repoPath: string, prNumber: number, options?: PullRequestAiOptions): Promise<PullRequestBrief>;
  getPullRequestStory(repoPath: string, prNumber: number, options?: PullRequestAiOptions): Promise<PullRequestStory>;
  getAppState(): Promise<AppState>;
  saveAppState(state: AppState): Promise<AppState>;
};
