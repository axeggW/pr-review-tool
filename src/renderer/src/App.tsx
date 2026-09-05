import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  ErrorInfo,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  GitPullRequest,
  Home,
  BookOpen,
  Loader2,
  X,
  Maximize2,
  Minimize2,
  Moon,
  Radar,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Settings,
  Sparkles,
  Star,
  Sun,
  Trash2
} from 'lucide-react';
import {
  Diff,
  Hunk,
  getChangeKey,
  parseDiff,
  type ChangeData,
  type FileData,
  type GutterOptions
} from 'react-diff-view';
import 'react-diff-view/style/index.css';
import type {
  DraftComment,
  ExistingPrComment,
  FavoritePullRequest,
  OpenPullRequest,
  PullRequestBrief,
  PullRequestStory,
  PullRequestStoryDiffTarget,
  PullRequestSummary,
  RepoStatus,
  ReviewApi,
  SavedRepo,
  AppSettings,
  ReviewFileLabel,
  ReviewLabelDefinition,
  ReviewLabelReport
} from '../../shared/types';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { Switch } from './components/ui/switch';
import { Textarea } from './components/ui/textarea';
import {
  resolveStoryDiffTarget,
  type ResolvedStoryDiffTarget
} from './lib/story-diff-targets';
import './styles.css';

type LoadState = 'idle' | 'loading' | 'error';
type Theme = 'light' | 'dark';
type ResizeSide = 'left' | 'right';
type CommentTarget = {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
};
type LineSelection = {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number;
  endLine: number;
} | null;
type LabelFilterValue = 'all' | string;
type LabelDefinitionView = ReviewLabelDefinition & {
  id: string;
  name: string;
  description?: string;
  color?: string;
};
type FileLabelView = ReviewFileLabel & {
  filePath?: string;
  path?: string;
  labelId?: string;
  labelIds?: string[];
  labels?: Array<string | ReviewLabelDefinition>;
};
type LabelReportView = ReviewLabelReport & {
  definitions?: ReviewLabelDefinition[];
  labelDefinitions?: ReviewLabelDefinition[];
  fileLabels?: ReviewFileLabel[];
  files?: ReviewFileLabel[];
};
type BriefState = 'idle' | 'loading' | 'ready' | 'error';
type StoryState = 'idle' | 'loading' | 'ready' | 'error';
type AppView = 'home' | 'workspace' | 'settings';
type AiPreloadState = 'idle' | 'loading' | 'ready' | 'error';

type ErrorBoundaryState = {
  error: Error | null;
};

const defaultSettings: Required<AppSettings> = {
  autoOpenLastPullRequest: false,
  generateBriefOnOpen: true,
  generateStoryWithLocalCodex: true,
  checkResolutionWithLocalCodex: true,
  obfuscatePathsAndUrls: false,
  defaultTheme: 'system'
};

function repoNameFromPath(repoRoot: string): string {
  return repoRoot.split('/').filter(Boolean).at(-1) ?? repoRoot;
}

function displaySensitivePath(value: string | null | undefined, obfuscate: boolean): string {
  if (!value) return '';
  if (!obfuscate) return value;

  if (/^[a-z]+:\/\//i.test(value)) {
    return value.startsWith('mock://') ? 'mock://demo/pr' : 'URL hidden for demo';
  }

  const parts = value.split('/').filter(Boolean);
  const markerIndex = parts.indexOf('.pr-review-tool');
  if (markerIndex >= 1) {
    return `/.../${parts.slice(markerIndex - 1).join('/')}`;
  }

  return `/.../${parts.at(-1) ?? 'repo'}`;
}

function normalizeSavedRepo(repo: SavedRepo): SavedRepo {
  return {
    ...repo,
    name: repo.name || repoNameFromPath(repo.root),
    lastOpenedAt: repo.lastOpenedAt || new Date().toISOString()
  };
}

function favoriteKey(repoRoot: string, prNumber: number): string {
  return `${repoRoot}#${prNumber}`;
}

function makeFavoritePullRequest(repo: RepoStatus, pr: PullRequestSummary): FavoritePullRequest {
  return {
    repoRoot: repo.root,
    repoName: repoNameFromPath(repo.root),
    number: pr.number,
    title: pr.title,
    author: pr.author,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    url: pr.url,
    updatedAt: pr.updatedAt,
    favoritedAt: new Date().toISOString()
  };
}

function savedRepoFromStatus(repo: RepoStatus): SavedRepo {
  return normalizeSavedRepo({
    root: repo.root,
    name: repoNameFromPath(repo.root),
    remoteUrl: repo.remoteUrl,
    githubReady: repo.githubReady,
    lastOpenedAt: new Date().toISOString()
  });
}

function mergeSavedRepos(primary: SavedRepo[], secondary: SavedRepo[]): SavedRepo[] {
  const byRoot = new Map<string, SavedRepo>();
  for (const repo of [...secondary, ...primary]) {
    byRoot.set(repo.root, normalizeSavedRepo(repo));
  }
  return [...byRoot.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

function hasReviewApiMethod<K extends keyof ReviewApi>(
  reviewApi: ReviewApi | undefined,
  methodName: K
): reviewApi is ReviewApi & Record<K, NonNullable<ReviewApi[K]>> {
  return typeof reviewApi?.[methodName] === 'function';
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Renderer crashed', error, errorInfo);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="app-shell">
        <div className="fatal-error">
          <h1>Something broke in the review UI.</h1>
          <p>{this.state.error.message}</p>
          <Button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </main>
    );
  }
}

function lineNumberForChange(change: ChangeData | null | undefined, side: 'LEFT' | 'RIGHT'): number | null {
  if (!change) return null;

  if (side === 'LEFT') {
    if ('oldLineNumber' in change && typeof change.oldLineNumber === 'number') return change.oldLineNumber;
    if ('lineNumber' in change && typeof change.lineNumber === 'number' && change.type === 'delete') return change.lineNumber;
    return null;
  }

  if ('newLineNumber' in change && typeof change.newLineNumber === 'number') return change.newLineNumber;
  if ('lineNumber' in change && typeof change.lineNumber === 'number' && change.type === 'insert') return change.lineNumber;
  return null;
}

function makeDraftComment(prNumber: number, target: CommentTarget): DraftComment {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    prNumber,
    type: 'line',
    filePath: target.filePath,
    side: target.side,
    line: target.line,
    body: '',
    status: 'draft',
    createdAt: now,
    updatedAt: now
  };
}

function makeBlockComment(prNumber: number, start: CommentTarget, end: CommentTarget): DraftComment {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    prNumber,
    type: 'block',
    filePath: start.filePath,
    side: start.side,
    startLine: Math.min(start.line, end.line),
    endLine: Math.max(start.line, end.line),
    body: '',
    status: 'draft',
    createdAt: now,
    updatedAt: now
  };
}

function makeCommentFromSelection(prNumber: number, selection: NonNullable<LineSelection>): DraftComment {
  const start = {
    filePath: selection.filePath,
    side: selection.side,
    line: selection.startLine
  };
  const end = {
    filePath: selection.filePath,
    side: selection.side,
    line: selection.endLine
  };

  if (selection.startLine === selection.endLine) return makeDraftComment(prNumber, start);
  return makeBlockComment(prNumber, start, end);
}

function makeSummaryComment(prNumber: number): DraftComment {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    prNumber,
    type: 'summary',
    body: '',
    status: 'draft',
    createdAt: now,
    updatedAt: now
  };
}

function changeMatchesComment(change: ChangeData | null | undefined, comment: DraftComment): boolean {
  if (comment.type === 'summary' || !comment.side) return false;
  const line = lineNumberForChange(change, comment.side);
  if (!line) return false;
  if (comment.type === 'block') return line === comment.endLine;
  return line === comment.line;
}

function changeIsInsideBlock(change: ChangeData | null | undefined, comment: DraftComment): boolean {
  if (comment.type !== 'block' || !comment.side || !comment.startLine || !comment.endLine) return false;
  const line = lineNumberForChange(change, comment.side);
  return Boolean(line && line >= comment.startLine && line <= comment.endLine);
}

function changeIsInsideSelection(change: ChangeData | null | undefined, selection: LineSelection): boolean {
  if (!selection) return false;
  const line = lineNumberForChange(change, selection.side);
  const startLine = Math.min(selection.startLine, selection.endLine);
  const endLine = Math.max(selection.startLine, selection.endLine);
  return Boolean(line && line >= startLine && line <= endLine);
}

function commentLocationLabel(comment: DraftComment): string {
  if (comment.type === 'summary') return 'Summary';
  if (!comment.filePath) return 'Unknown location';
  if (comment.type === 'block') return `${comment.filePath}:${comment.startLine}-${comment.endLine}`;
  return `${comment.filePath}:${comment.line}`;
}

function commentStatusLabel(comment: DraftComment): string {
  if (comment.status === 'draft') return 'Not pushed';
  if (comment.status === 'deleted') return 'Delete pending';
  if (comment.status === 'pushed') return 'Pushed';
  if (comment.status === 'stale') return 'Stale';
  return comment.status;
}

function commentStatusClassName(comment: DraftComment): string {
  return `status-pill status-${comment.status}`;
}

function resolutionStatusLabel(comment: DraftComment): string {
  const status = comment.resolution?.status ?? 'unchecked';
  if (status === 'still-relevant') return 'Still relevant';
  if (status === 'needs-review') return 'Needs review';
  if (status === 'resolved') return 'Resolved';
  if (status === 'stale') return 'Stale';
  return 'Unchecked';
}

function resolutionStatusClassName(comment: DraftComment): string {
  const status = comment.resolution?.status ?? 'unchecked';
  return `resolution-pill resolution-${status}`;
}

function existingCommentLocationLabel(comment: ExistingPrComment): string {
  if (comment.type === 'summary') return 'Conversation';
  if (!comment.filePath) return 'Unknown location';
  if (comment.type === 'block') return `${comment.filePath}:${comment.startLine}-${comment.endLine}`;
  return `${comment.filePath}:${comment.line}`;
}

function labelDefinitionId(definition: ReviewLabelDefinition): string {
  return (definition as LabelDefinitionView).id;
}

function labelDefinitionName(definition: ReviewLabelDefinition): string {
  return (definition as LabelDefinitionView).name;
}

function labelDefinitionDescription(definition: ReviewLabelDefinition): string | undefined {
  return (definition as LabelDefinitionView).description;
}

function labelDefinitionColor(definition: ReviewLabelDefinition): string | undefined {
  return (definition as LabelDefinitionView).color;
}

function getLabelDefinitions(report: ReviewLabelReport | null): ReviewLabelDefinition[] {
  if (!report) return [];
  const view = report as LabelReportView;
  return view.definitions ?? view.labelDefinitions ?? [];
}

function getFileLabels(report: ReviewLabelReport | null): ReviewFileLabel[] {
  if (!report) return [];
  const view = report as LabelReportView;
  return view.fileLabels ?? view.files ?? [];
}

function fileLabelPath(fileLabel: ReviewFileLabel): string {
  const view = fileLabel as FileLabelView;
  return view.filePath ?? view.path ?? 'unknown-file';
}

function fileLabelIds(fileLabel: ReviewFileLabel): string[] {
  const view = fileLabel as FileLabelView;
  if (view.labelId) return [view.labelId];
  if (view.labelIds) return view.labelIds;
  if (view.labels) {
    return view.labels.map((label: string | ReviewLabelDefinition) =>
      typeof label === 'string' ? label : labelDefinitionId(label)
    );
  }
  return [];
}

function buildLabelLookup(definitions: ReviewLabelDefinition[]): Map<string, ReviewLabelDefinition> {
  return new Map(definitions.map((definition) => [labelDefinitionId(definition), definition]));
}

function labelBadgeStyle(definition: ReviewLabelDefinition): CSSProperties | undefined {
  const color = labelDefinitionColor(definition);
  return color ? ({ '--label-color': color } as CSSProperties) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function ReviewLabelBadge({ definition }: { definition: ReviewLabelDefinition }): ReactElement {
  return (
    <span className="review-label-badge" style={labelBadgeStyle(definition)} title={labelDefinitionDescription(definition)}>
      {labelDefinitionName(definition)}
    </span>
  );
}

function ReviewLabelSummary({
  report,
  activeLabelId,
  onActiveLabelChange
}: {
  report: ReviewLabelReport | null;
  activeLabelId: LabelFilterValue;
  onActiveLabelChange: (labelId: LabelFilterValue) => void;
}): ReactElement | null {
  const definitions = getLabelDefinitions(report);
  const labelCounts = getFileLabels(report).reduce<Map<string, number>>((counts, fileLabel) => {
    for (const labelId of fileLabelIds(fileLabel)) {
      counts.set(labelId, (counts.get(labelId) ?? 0) + 1);
    }
    return counts;
  }, new Map());
  const labeledFileCount = new Set(getFileLabels(report).map(fileLabelPath)).size;

  if (!report || definitions.length === 0) return null;

  return (
    <div className="review-label-summary" aria-label="Deterministic review labels">
      <div className="review-label-summary-copy">
        <strong>{labeledFileCount} labeled files</strong>
        <span>{definitions.length} deterministic labels</span>
      </div>
      <div className="review-label-filters" aria-label="Filter files by label">
        <button
          type="button"
          className={activeLabelId === 'all' ? 'review-label-chip is-active' : 'review-label-chip'}
          onClick={() => onActiveLabelChange('all')}
        >
          All
        </button>
        {definitions.map((definition) => {
          const labelId = labelDefinitionId(definition);
          return (
            <button
              type="button"
              className={activeLabelId === labelId ? 'review-label-chip is-active' : 'review-label-chip'}
              key={labelId}
              onClick={() => onActiveLabelChange(labelId)}
              title={labelDefinitionDescription(definition)}
            >
              <span className="review-label-chip-dot" style={labelBadgeStyle(definition)} />
              <span className="review-label-chip-name">{labelDefinitionName(definition)}</span>
              <span>{labelCounts.get(labelId) ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PullRequestBriefPanel({
  brief,
  briefState,
  error
}: {
  brief: PullRequestBrief | null;
  briefState: BriefState;
  error: string | null;
}): ReactElement | null {
  if (briefState === 'idle' && !brief) return null;

  if (briefState === 'loading') {
    return (
      <section className="pr-brief">
        <div className="pr-brief-main">
          <span className="pr-brief-kicker">Opening brief</span>
          <h3>Reading this PR with local Codex...</h3>
          <p>Diff, deterministic labels, and prior comment state are being stitched together.</p>
        </div>
      </section>
    );
  }

  if (briefState === 'error') {
    return (
      <section className="pr-brief is-error">
        <div className="pr-brief-main">
          <span className="pr-brief-kicker">Opening brief</span>
          <h3>Could not generate the PR brief.</h3>
          <p>{error ?? 'Local Codex did not return a usable brief.'}</p>
        </div>
      </section>
    );
  }

  if (!brief) return null;

  return (
    <section className="pr-brief">
      <div className="pr-brief-main">
        <span className="pr-brief-kicker">Opening brief</span>
        <h3>{brief.summary}</h3>
        <p>{brief.codebaseFit}</p>
      </div>
      <div className="pr-brief-tags">
        {brief.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <div className="pr-brief-grid">
        <div>
          <span className="pr-brief-section-title">Review Focus</span>
          {brief.reviewFocus.length > 0 ? (
            <ul>
              {brief.reviewFocus.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No focused review notes yet.</p>
          )}
        </div>
        <div>
          <span className="pr-brief-section-title">Risks</span>
          {brief.risks.length > 0 ? (
            <ul>
              {brief.risks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No obvious risk notes.</p>
          )}
        </div>
        <div>
          <span className="pr-brief-section-title">Your Comments</span>
          <div className="pr-brief-comment-status">
            <span>{brief.commentStatus.total} total</span>
            <span>{brief.commentStatus.resolved} resolved</span>
            <span>{brief.commentStatus.stillRelevant} still relevant</span>
            <span>{brief.commentStatus.needsReview} needs review</span>
            <span>{brief.commentStatus.stale} stale</span>
            <span>{brief.commentStatus.unchecked} unchecked</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function PullRequestStoryPanel({
  story,
  storyState,
  error,
  obfuscatePathsAndUrls,
  onOpenDiffTarget,
  onClose
}: {
  story: PullRequestStory | null;
  storyState: StoryState;
  error: string | null;
  obfuscatePathsAndUrls: boolean;
  onOpenDiffTarget: (target: PullRequestStoryDiffTarget) => void;
  onClose: () => void;
}): ReactElement {
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const slides = story?.slides ?? [];
  const activeSlide = slides[Math.min(activeSlideIndex, Math.max(slides.length - 1, 0))];
  const isFirstSlide = activeSlideIndex <= 0;
  const isLastSlide = activeSlideIndex >= slides.length - 1;

  useEffect(() => {
    setActiveSlideIndex(0);
  }, [story?.generatedAt]);

  function slideLabel(kind: string): string {
    return kind
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  return (
    <div className="story-overlay" role="dialog" aria-modal="true" aria-label="Product Story">
      <Card className="story-panel">
        <CardHeader className="story-panel-header">
          <div>
            <p className="eyebrow">Product Story</p>
            <h2>{story?.title ?? 'Building the Product Story...'}</h2>
            {story?.repoGuidancePath ? (
              <p>Guided by {displaySensitivePath(story.repoGuidancePath, obfuscatePathsAndUrls)}</p>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close Product Story">
            <X size={18} />
          </Button>
        </CardHeader>
        <CardContent className="story-panel-body">
          {storyState === 'loading' ? (
            <div className="story-loading">
              <h3>Reading the diff, comments, labels, and repo guide...</h3>
              <p>Local Codex is turning this into a click-through preflight with concrete diff targets.</p>
            </div>
          ) : null}
          {storyState === 'error' ? (
            <div className="story-loading is-error">
              <h3>Could not build the Product Story.</h3>
              <p>{error ?? 'Local Codex did not return a usable story.'}</p>
            </div>
          ) : null}
          {story && storyState === 'ready' && activeSlide ? (
            <>
              <p className="story-summary">{story.summary}</p>
              <section className="story-slide">
                <div className="story-slide-meta">
                  <span>{slideLabel(activeSlide.kind)}</span>
                  <span>
                    Slide {activeSlideIndex + 1} of {slides.length}
                  </span>
                </div>
                <h3>{activeSlide.title}</h3>
                <p>{activeSlide.narrative}</p>
                {activeSlide.diffTargets.length > 0 ? (
                  <div className="story-diff-targets">
                    {activeSlide.diffTargets.map((target) => (
                      <Card className="story-diff-target" key={`${activeSlide.title}-${target.filePath}-${target.line ?? 'file'}`}>
                        <div>
                          <strong>{target.title}</strong>
                          <span>
                            {target.filePath}
                            {target.line ? `:${target.line}` : ''}
                          </span>
                          <p>{target.reason}</p>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => onOpenDiffTarget(target)}>
                          <ArrowRight size={14} />
                          Open Diff
                        </Button>
                      </Card>
                    ))}
                  </div>
                ) : null}
                <div className="story-fragments">
                  {activeSlide.fragments.map((fragment) => (
                    <div className="story-fragment" key={`${activeSlide.title}-${fragment.filePath}-${fragment.title}`}>
                      <div className="story-fragment-header">
                        <strong>{fragment.title}</strong>
                        <span>
                          {fragment.filePath}
                          {fragment.language ? ` · ${fragment.language}` : ''}
                        </span>
                      </div>
                      <pre>
                        <code>{fragment.code}</code>
                      </pre>
                      <p>{fragment.explanation}</p>
                    </div>
                  ))}
                </div>
              </section>
              {isLastSlide && story.prioritizedReviewPath.length > 0 ? (
                <section className="story-path">
                  <h3>Prioritized Review Path</h3>
                  <div className="story-diff-targets">
                    {story.prioritizedReviewPath.map((target) => (
                      <Card className="story-diff-target" key={`path-${target.filePath}-${target.line ?? target.title}`}>
                        <div>
                          <strong>{target.title}</strong>
                          <span>
                            {target.filePath}
                            {target.line ? `:${target.line}` : ''}
                          </span>
                          <p>{target.reason}</p>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => onOpenDiffTarget(target)}>
                          <ArrowRight size={14} />
                          Open Diff
                        </Button>
                      </Card>
                    ))}
                  </div>
                </section>
              ) : null}
              <div className="story-panel-footer">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isFirstSlide}
                  onClick={() => setActiveSlideIndex((current) => Math.max(0, current - 1))}
                >
                  <ArrowLeft size={14} />
                  Previous
                </Button>
                <div className="story-progress" aria-label={`Slide ${activeSlideIndex + 1} of ${slides.length}`}>
                  {slides.map((slide, index) => (
                    <button
                      type="button"
                      className={index === activeSlideIndex ? 'is-active' : ''}
                      key={`${slide.kind}-${slide.title}`}
                      onClick={() => setActiveSlideIndex(index)}
                      aria-label={`Go to slide ${index + 1}`}
                    />
                  ))}
                </div>
                <Button
                  type="button"
                  disabled={isLastSlide}
                  onClick={() => setActiveSlideIndex((current) => Math.min(slides.length - 1, current + 1))}
                >
                  Next
                  <ArrowRight size={14} />
                </Button>
              </div>
            </>
          ) : null}
          {story && storyState === 'ready' && !activeSlide ? (
            <div className="story-loading is-error">
              <h3>Product Story is empty.</h3>
              <p>Local Codex returned a response without slides.</p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function InlineComment({
  comment,
  onUpdateComment,
  onDeleteComment
}: {
  comment: DraftComment;
  onUpdateComment: (comment: DraftComment, body: string) => void;
  onDeleteComment: (comment: DraftComment) => void;
}): ReactElement {
  const [isEditing, setIsEditing] = useState(comment.body.trim().length === 0);

  if (!isEditing && comment.body.trim().length > 0) {
    return (
      <div className="inline-comment-preview">
        <button type="button" className="inline-comment-preview-body" onClick={() => setIsEditing(true)}>
          <span className="inline-comment-preview-meta">
            <span className={commentStatusClassName(comment)}>{commentStatusLabel(comment)}</span>
            <span>{commentLocationLabel(comment)}</span>
          </span>
          <p>{comment.body}</p>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onDeleteComment(comment)}
          title="Delete local comment"
        >
          <Trash2 size={16} />
        </Button>
      </div>
    );
  }

  return (
    <Card className="inline-comment-editor">
      <div className="comment-meta">
        <span className={commentStatusClassName(comment)}>{commentStatusLabel(comment)}</span>
        <span>
          {commentLocationLabel(comment)}
        </span>
      </div>
      <Textarea
        autoFocus
        value={comment.body}
        onBlur={() => {
          if (comment.body.trim().length > 0) setIsEditing(false);
        }}
        onChange={(event) => onUpdateComment(comment, event.target.value)}
        placeholder="Write a line comment..."
      />
      <div className="inline-comment-actions">
        <Button type="button" variant="ghost" size="sm" onClick={() => onDeleteComment(comment)}>
          <Trash2 size={14} />
          Delete
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={comment.body.trim().length === 0}
          onClick={() => setIsEditing(false)}
        >
          Done
        </Button>
      </div>
    </Card>
  );
}

function DiffViewer({
  diff,
  fullContextDiff,
  comments,
  labelReport,
  activeLabelId,
  expandedFiles,
  highlightedStoryTarget,
  lineSelection,
  onAddComment,
  onStartLineSelection,
  onPreviewLineSelection,
  onCommitLineSelection,
  onUpdateComment,
  onDeleteComment,
  onToggleFileContext
}: {
  diff: string;
  fullContextDiff: string | null;
  comments: DraftComment[];
  labelReport: ReviewLabelReport | null;
  activeLabelId: LabelFilterValue;
  expandedFiles: Set<string>;
  highlightedStoryTarget: ResolvedStoryDiffTarget | null;
  lineSelection: LineSelection;
  onAddComment: (target: CommentTarget) => void;
  onStartLineSelection: (target: CommentTarget) => void;
  onPreviewLineSelection: (target: CommentTarget) => void;
  onCommitLineSelection: () => void;
  onUpdateComment: (comment: DraftComment, body: string) => void;
  onDeleteComment: (comment: DraftComment) => void;
  onToggleFileContext: (filePath: string) => void;
}): ReactElement {
  const files = useMemo(() => parseDiff(diff, { nearbySequences: 'zip' }), [diff]);
  const fullContextFiles = useMemo(() => parseDiff(fullContextDiff ?? '', { nearbySequences: 'zip' }), [fullContextDiff]);
  const labelDefinitions = useMemo(() => getLabelDefinitions(labelReport), [labelReport]);
  const labelLookup = useMemo(() => buildLabelLookup(labelDefinitions), [labelDefinitions]);
  const fileLabelMap = useMemo(() => {
    const next = new Map<string, ReviewLabelDefinition[]>();
    for (const fileLabel of getFileLabels(labelReport)) {
      const definitions = fileLabelIds(fileLabel)
        .map((labelId) => labelLookup.get(labelId))
        .filter((definition): definition is ReviewLabelDefinition => Boolean(definition));
      if (definitions.length > 0) next.set(fileLabelPath(fileLabel), definitions);
    }
    return next;
  }, [labelLookup, labelReport]);
  const visibleFiles = useMemo(() => {
    if (activeLabelId === 'all') return files;
    return files.filter((file) => {
      const filePath = file.newPath || file.oldPath || 'unknown-file';
      return fileLabelMap.get(filePath)?.some((definition) => labelDefinitionId(definition) === activeLabelId);
    });
  }, [activeLabelId, fileLabelMap, files]);

  if (files.length === 0) {
    return <div className="diff-empty">This PR has no text diff to show.</div>;
  }

  if (visibleFiles.length === 0) {
    return <div className="diff-empty">No changed files match that label.</div>;
  }

  function renderFile(file: FileData): ReactElement {
    const filePath = file.newPath || file.oldPath || 'unknown-file';
    const expandedFile = fullContextFiles.find((item) => (item.newPath || item.oldPath || 'unknown-file') === filePath);
    const isExpanded = expandedFiles.has(filePath);
    const renderedFile = isExpanded && expandedFile ? expandedFile : file;
    const fileComments = comments.filter((comment) => comment.filePath === filePath && comment.status !== 'deleted');
    const fileLabels = fileLabelMap.get(filePath) ?? [];
    const lineClassName = ({ changes, defaultGenerate }: { changes: Array<ChangeData | null>; defaultGenerate: () => string }) => {
      const hasBlockComment = changes.some((change) => fileComments.some((comment) => changeIsInsideBlock(change, comment)));
      const hasActiveSelection = changes.some((change) => changeIsInsideSelection(change, lineSelection));
      const hasStoryTarget = changes.some((change) => {
        if (!highlightedStoryTarget || highlightedStoryTarget.filePath !== filePath) return false;
        const line = lineNumberForChange(change, highlightedStoryTarget.side);
        return Boolean(line && line === highlightedStoryTarget.line);
      });
      const base = defaultGenerate();
      return [base, hasBlockComment ? 'has-block-comment' : '', hasActiveSelection ? 'has-line-selection' : '', hasStoryTarget ? 'is-story-target' : '']
        .filter(Boolean)
        .join(' ');
    };
    const widgets = renderedFile.hunks.reduce<Record<string, ReactElement>>((currentWidgets, hunk) => {
      for (const change of hunk.changes) {
        const lineComments = fileComments.filter((comment) => comment.type !== 'summary' && changeMatchesComment(change, comment));
        if (lineComments.length === 0) continue;

        currentWidgets[getChangeKey(change)] = (
          <div className="inline-comments">
            {lineComments.map((comment) => (
              <InlineComment
                comment={comment}
                key={comment.id}
                onUpdateComment={onUpdateComment}
                onDeleteComment={onDeleteComment}
              />
            ))}
          </div>
        );
      }

      return currentWidgets;
    }, {});
    const renderGutter = ({ change, side, renderDefault }: GutterOptions): ReactElement => {
      const reviewSide = side === 'old' ? 'LEFT' : 'RIGHT';
      const line = lineNumberForChange(change, reviewSide);
      const hasComment = line
        ? fileComments.some((comment) => comment.side === reviewSide && comment.line === line)
        : false;
      const isSelected =
        line !== null &&
        lineSelection?.filePath === filePath &&
        lineSelection.side === reviewSide &&
        line >= Math.min(lineSelection.startLine, lineSelection.endLine) &&
        line <= Math.max(lineSelection.startLine, lineSelection.endLine);

      function targetForLine(): CommentTarget | null {
        return line ? { filePath, side: reviewSide, line } : null;
      }

      function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
        const target = targetForLine();
        if (!target) return;
        event.preventDefault();
        onStartLineSelection(target);
      }

      function handlePointerEnter(): void {
        const target = targetForLine();
        if (target) onPreviewLineSelection(target);
      }

      function handlePointerUp(): void {
        onCommitLineSelection();
      }

      function handleClick(event: ReactMouseEvent<HTMLButtonElement>): void {
        const target = targetForLine();
        if (event.detail === 0 && target) onAddComment(target);
      }

      return (
        <Button
          type="button"
          className={[
            'diff-gutter-button',
            hasComment ? 'has-comment' : '',
            isSelected ? 'is-line-selected' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          variant="ghost"
          disabled={!line}
          data-diff-line-anchor={line ? 'true' : undefined}
          data-file-path={line ? filePath : undefined}
          data-side={line ? reviewSide : undefined}
          data-line={line ?? undefined}
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerEnter={handlePointerEnter}
          onPointerUp={handlePointerUp}
          title={line ? `Comment on ${filePath}:${line}` : undefined}
        >
          {renderDefault()}
        </Button>
      );
    };

    return (
      <section className="diff-file" data-file-path={filePath} key={`${file.oldRevision}-${file.newRevision}-${filePath}`}>
        <header className="diff-file-header">
          <div className="diff-file-title">
            <span className="diff-file-path">{filePath}</span>
            {fileLabels.length > 0 ? (
              <span className="diff-file-labels">
                {fileLabels.map((definition) => (
                  <ReviewLabelBadge definition={definition} key={labelDefinitionId(definition)} />
                ))}
              </span>
            ) : null}
          </div>
          <div className="diff-file-actions">
            <Button type="button" size="sm" variant="outline" onClick={() => onToggleFileContext(filePath)}>
              {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {isExpanded ? 'Compact' : 'Expand file'}
            </Button>
          </div>
        </header>
        <Diff
          viewType="split"
          diffType={renderedFile.type}
          hunks={renderedFile.hunks}
          generateLineClassName={lineClassName}
          renderGutter={renderGutter}
          widgets={widgets}
        >
          {(hunks) => hunks.map((hunk) => <Hunk hunk={hunk} key={hunk.content} />)}
        </Diff>
      </section>
    );
  }

  return <div className="diff-viewer">{visibleFiles.map(renderFile)}</div>;
}

function HomeDashboard({
  savedRepos,
  favorites,
  preloadStates,
  activeRepoRoot,
  loadState,
  obfuscatePathsAndUrls,
  onChooseRepo,
  onOpenRepo,
  onOpenFavorite,
  onPreloadFavorite,
  onRemoveFavorite
}: {
  savedRepos: SavedRepo[];
  favorites: FavoritePullRequest[];
  preloadStates: Record<string, AiPreloadState>;
  activeRepoRoot: string | null;
  loadState: LoadState;
  obfuscatePathsAndUrls: boolean;
  onChooseRepo: () => void;
  onOpenRepo: (repoRoot: string) => void;
  onOpenFavorite: (favorite: FavoritePullRequest) => void;
  onPreloadFavorite: (favorite: FavoritePullRequest) => void;
  onRemoveFavorite: (favorite: FavoritePullRequest) => void;
}): ReactElement {
  return (
    <section className="home-dashboard">
      <Card className="home-command-card">
        <CardHeader className="home-command-header">
          <div>
            <p className="eyebrow">Review Console</p>
            <h2>Start from a repo or a favorite PR.</h2>
            <p>Repos you open are saved here. Star high-priority PRs to keep them one click away.</p>
          </div>
          <Button type="button" onClick={onChooseRepo} disabled={loadState === 'loading'}>
            <FolderOpen size={16} />
            Add Repo
          </Button>
        </CardHeader>
        <CardContent className="home-stats">
          <div>
            <strong>{savedRepos.length}</strong>
            <span>saved repos</span>
          </div>
          <div>
            <strong>{favorites.length}</strong>
            <span>favorite PRs</span>
          </div>
          <div>
            <strong>{activeRepoRoot ? repoNameFromPath(activeRepoRoot) : 'None'}</strong>
            <span>active repo</span>
          </div>
        </CardContent>
      </Card>

      <div className="home-grid">
        <Card className="home-section-card">
          <CardHeader className="home-section-header">
            <div>
              <h3>Repositories</h3>
              <p>Local projects available for review.</p>
            </div>
            <span>{savedRepos.length}</span>
          </CardHeader>
          <CardContent className="repo-card-grid">
            {savedRepos.map((item) => (
              <button
                type="button"
                className={activeRepoRoot === item.root ? 'repo-card is-active' : 'repo-card'}
                key={item.root}
                onClick={() => onOpenRepo(item.root)}
              >
                <span className="repo-card-icon">
                  <FolderOpen size={18} />
                </span>
                <strong>{item.name}</strong>
                <small>{displaySensitivePath(item.root, obfuscatePathsAndUrls)}</small>
                <span className={item.githubReady ? 'repo-card-status is-ready' : 'repo-card-status'}>
                  {item.githubReady ? 'GitHub ready' : 'Needs GitHub auth'}
                </span>
              </button>
            ))}
            {savedRepos.length === 0 ? (
              <div className="home-empty">
                <p>No repositories yet.</p>
                <Button type="button" onClick={onChooseRepo} disabled={loadState === 'loading'} variant="outline">
                  <FolderOpen size={16} />
                  Open your first repo
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="home-section-card">
          <CardHeader className="home-section-header">
            <div>
              <h3>Favorite PRs</h3>
              <p>Fast lanes back into active reviews.</p>
            </div>
            <span>{favorites.length}</span>
          </CardHeader>
          <CardContent className="favorite-list">
            {favorites.map((favorite) => (
              <Card className="favorite-card" key={favoriteKey(favorite.repoRoot, favorite.number)}>
                <button type="button" className="favorite-main" onClick={() => onOpenFavorite(favorite)}>
                  <span className="pr-number">
                    <GitPullRequest size={14} />
                    #{favorite.number}
                  </span>
                  <strong>{favorite.title}</strong>
                  <small>
                    {favorite.repoName} · {favorite.headRefName} into {favorite.baseRefName}
                  </small>
                </button>
                <PreloadButton
                  state={preloadStates[favoriteKey(favorite.repoRoot, favorite.number)] ?? 'idle'}
                  onClick={() => onPreloadFavorite(favorite)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemoveFavorite(favorite)}
                  title="Remove favorite"
                  aria-label="Remove favorite"
                >
                  <Star size={15} fill="currentColor" />
                </Button>
              </Card>
            ))}
            {favorites.length === 0 ? (
              <div className="home-empty">
                <p>Favorite PRs from the PR list to pin them here.</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function PreloadButton({ state, onClick }: { state: AiPreloadState; onClick: () => void }): ReactElement {
  const isLoading = state === 'loading';
  const title =
    state === 'ready'
      ? 'AI context preloaded'
      : state === 'error'
        ? 'Retry AI preload'
        : 'Preload AI context';

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={['preload-toggle', state === 'ready' ? 'is-ready' : '', state === 'error' ? 'is-error' : '']
        .filter(Boolean)
        .join(' ')}
      disabled={isLoading}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {isLoading ? <Loader2 size={15} /> : state === 'ready' ? <Check size={15} /> : <Sparkles size={15} />}
    </Button>
  );
}

function SettingsPanel({
  settings,
  onUpdateSettings
}: {
  settings: Required<AppSettings>;
  onUpdateSettings: (settings: Required<AppSettings>) => void;
}): ReactElement {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <p className="eyebrow">Settings</p>
        <h2>Review workspace preferences</h2>
      </div>
      <div className="settings-list">
        <Card className="settings-row">
          <div>
            <strong>Restore last PR automatically</strong>
            <p>When the app opens, jump straight into the last active PR after loading its repo.</p>
          </div>
          <Switch
            checked={settings.autoOpenLastPullRequest}
            onCheckedChange={(checked) => onUpdateSettings({ ...settings, autoOpenLastPullRequest: checked })}
            aria-label="Restore last PR automatically"
          />
        </Card>
        <Card className="settings-row">
          <div>
            <strong>Generate opening brief</strong>
            <p>Use local Codex when a PR opens to summarize intent, fit, risks, tags, and comment status.</p>
          </div>
          <Switch
            checked={settings.generateBriefOnOpen}
            onCheckedChange={(checked) => onUpdateSettings({ ...settings, generateBriefOnOpen: checked })}
            aria-label="Generate opening brief"
          />
        </Card>
        <Card className="settings-row">
          <div>
            <strong>Generate Product Story</strong>
            <p>Use local Codex on demand to build a click-through preflight with code fragments and diff targets.</p>
          </div>
          <Switch
            checked={settings.generateStoryWithLocalCodex}
            onCheckedChange={(checked) => onUpdateSettings({ ...settings, generateStoryWithLocalCodex: checked })}
            aria-label="Generate Product Story"
          />
        </Card>
        <Card className="settings-row">
          <div>
            <strong>Enable local Codex resolution checks</strong>
            <p>Allow the comments panel to ask local Codex whether previous review comments look resolved.</p>
          </div>
          <Switch
            checked={settings.checkResolutionWithLocalCodex}
            onCheckedChange={(checked) => onUpdateSettings({ ...settings, checkResolutionWithLocalCodex: checked })}
            aria-label="Enable local Codex resolution checks"
          />
        </Card>
        <Card className="settings-row">
          <div>
            <strong>Obfuscate paths and URLs</strong>
            <p>Hide local usernames, full filesystem paths, and repository URLs while presenting demos.</p>
          </div>
          <Switch
            checked={settings.obfuscatePathsAndUrls}
            onCheckedChange={(checked) => onUpdateSettings({ ...settings, obfuscatePathsAndUrls: checked })}
            aria-label="Obfuscate paths and URLs"
          />
        </Card>
      </div>
    </section>
  );
}

function ReviewApp(): ReactElement {
  const reviewApi = window.reviewApi;
  const [view, setView] = useState<AppView>('home');
  const [theme, setTheme] = useState<Theme>('light');
  const [savedRepos, setSavedRepos] = useState<SavedRepo[]>([]);
  const [favoritePullRequests, setFavoritePullRequests] = useState<FavoritePullRequest[]>([]);
  const [settings, setSettings] = useState<Required<AppSettings>>(defaultSettings);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [activePullRequest, setActivePullRequest] = useState<OpenPullRequest | null>(null);
  const [openingPullRequestNumber, setOpeningPullRequestNumber] = useState<number | null>(null);
  const [comments, setComments] = useState<DraftComment[]>([]);
  const [existingComments, setExistingComments] = useState<ExistingPrComment[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [message, setMessage] = useState('Open a local git repository to start reviewing.');
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(292);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(320);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [appStateLoaded, setAppStateLoaded] = useState(false);
  const [fullContextPullRequest, setFullContextPullRequest] = useState<OpenPullRequest | null>(null);
  const [reviewLabelReport, setReviewLabelReport] = useState<ReviewLabelReport | null>(null);
  const [pullRequestBrief, setPullRequestBrief] = useState<PullRequestBrief | null>(null);
  const [briefState, setBriefState] = useState<BriefState>('idle');
  const [briefError, setBriefError] = useState<string | null>(null);
  const [pullRequestStory, setPullRequestStory] = useState<PullRequestStory | null>(null);
  const [storyState, setStoryState] = useState<StoryState>('idle');
  const [storyError, setStoryError] = useState<string | null>(null);
  const [storyPanelOpen, setStoryPanelOpen] = useState(false);
  const [preloadStates, setPreloadStates] = useState<Record<string, AiPreloadState>>({});
  const [preloadedBriefs, setPreloadedBriefs] = useState<Record<string, PullRequestBrief>>({});
  const [preloadedStories, setPreloadedStories] = useState<Record<string, PullRequestStory>>({});
  const [activeLabelId, setActiveLabelId] = useState<LabelFilterValue>('all');
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const [pendingStoryTarget, setPendingStoryTarget] = useState<ResolvedStoryDiffTarget | null>(null);
  const [highlightedStoryTarget, setHighlightedStoryTarget] = useState<ResolvedStoryDiffTarget | null>(null);
  const [lineSelection, setLineSelection] = useState<LineSelection>(null);
  const lineSelectionRef = useRef<LineSelection>(null);
  const openPullRequestIdRef = useRef(0);
  const storyRequestIdRef = useRef(0);

  const pendingSyncCount = useMemo(
    () => comments.filter((comment) => comment.status === 'draft' || comment.status === 'deleted').length,
    [comments]
  );
  const pendingDeleteCount = useMemo(
    () => comments.filter((comment) => comment.status === 'deleted').length,
    [comments]
  );
  const pendingPostCount = pendingSyncCount - pendingDeleteCount;
  const activeDiffFilePaths = useMemo(() => {
    if (!activePullRequest) return [];
    return parseDiff(activePullRequest.diff, { nearbySequences: 'zip' }).map(
      (file) => file.newPath || file.oldPath || 'unknown-file'
    );
  }, [activePullRequest]);
  const storyDiffTargetFilePaths = useMemo(() => {
    const paths = new Set(activeDiffFilePaths);
    if (fullContextPullRequest) {
      for (const file of parseDiff(fullContextPullRequest.diff, { nearbySequences: 'zip' })) {
        paths.add(file.newPath || file.oldPath || 'unknown-file');
      }
    }
    return Array.from(paths);
  }, [activeDiffFilePaths, fullContextPullRequest]);
  const activePrIsFavorite = Boolean(
    repo &&
      activePullRequest &&
      favoritePullRequests.some((favorite) => favoriteKey(favorite.repoRoot, favorite.number) === favoriteKey(repo.root, activePullRequest.number))
  );
  const syncButtonLabel = useMemo(() => {
    if (pendingSyncCount === 0) return 'Nothing to sync';
    if (pendingPostCount > 0 && pendingDeleteCount > 0) {
      return `Sync ${pendingPostCount} comment${pendingPostCount === 1 ? '' : 's'} and ${pendingDeleteCount} deletion${
        pendingDeleteCount === 1 ? '' : 's'
      }`;
    }
    if (pendingDeleteCount > 0) return `Sync ${pendingDeleteCount} deletion${pendingDeleteCount === 1 ? '' : 's'}`;
    return `Sync ${pendingPostCount} comment${pendingPostCount === 1 ? '' : 's'}`;
  }, [pendingDeleteCount, pendingPostCount, pendingSyncCount]);

  useEffect(() => {
    if (!reviewApi) {
      setAppStateLoaded(true);
      return;
    }

    const api = reviewApi;
    let cancelled = false;

    async function restoreAppState(): Promise<void> {
      try {
        const savedState = await api.getAppState();
        if (cancelled) return;

        const nextSettings = { ...defaultSettings, ...(savedState.settings ?? {}) };
        const repos = (savedState.savedRepos ?? [])
          .map(normalizeSavedRepo)
          .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
        setSettings(nextSettings);
        const demoRepos = await api.listDemoRepos().catch(() => []);
        const mergedRepos = mergeSavedRepos(repos, demoRepos.map(savedRepoFromStatus));
        setSavedRepos(mergedRepos);
        setFavoritePullRequests(savedState.favoritePullRequests ?? []);

        if (savedState.theme) setTheme(savedState.theme);
        if (typeof savedState.leftSidebarWidth === 'number') {
          setLeftSidebarWidth(clamp(savedState.leftSidebarWidth, 220, 460));
        }
        if (typeof savedState.rightSidebarWidth === 'number') {
          setRightSidebarWidth(clamp(savedState.rightSidebarWidth, 260, 520));
        }
        if (typeof savedState.leftSidebarCollapsed === 'boolean') {
          setLeftSidebarCollapsed(savedState.leftSidebarCollapsed);
        }
        if (typeof savedState.rightSidebarCollapsed === 'boolean') {
          setRightSidebarCollapsed(savedState.rightSidebarCollapsed);
        }

        if (savedState.lastRepoPath) {
          await loadRepo(
            savedState.lastRepoPath,
            nextSettings.autoOpenLastPullRequest ? savedState.activePullRequestNumber : undefined
          );
          if (!nextSettings.autoOpenLastPullRequest) setView('home');
        }
      } catch (error) {
        if (!cancelled) {
          setLoadState('error');
          setMessage(error instanceof Error ? error.message : 'Could not restore the last repository.');
        }
      } finally {
        if (!cancelled) setAppStateLoaded(true);
      }
    }

    void restoreAppState();

    return () => {
      cancelled = true;
    };
  }, [reviewApi]);

  useEffect(() => {
    if (!pendingStoryTarget) return;

    const timeoutId = window.setTimeout(() => {
      if (scrollToRenderedStoryTarget(pendingStoryTarget)) {
        setHighlightedStoryTarget(pendingStoryTarget);
        setPendingStoryTarget(null);
      }
    }, 80);

    return () => window.clearTimeout(timeoutId);
  }, [activePullRequest?.diff, expandedFiles, fullContextPullRequest?.diff, pendingStoryTarget]);

  useEffect(() => {
    if (!reviewApi || !appStateLoaded) return;
    void reviewApi.saveAppState({
      savedRepos,
      favoritePullRequests,
      settings,
      theme,
      leftSidebarWidth,
      rightSidebarWidth,
      leftSidebarCollapsed,
      rightSidebarCollapsed
    });
  }, [
    appStateLoaded,
    favoritePullRequests,
    leftSidebarCollapsed,
    leftSidebarWidth,
    reviewApi,
    rightSidebarCollapsed,
    rightSidebarWidth,
    savedRepos,
    settings,
    theme
  ]);

  async function loadRepo(repoPath: string, activePrNumber?: number): Promise<RepoStatus | null> {
    if (!reviewApi) return null;
    setLoadState('loading');
    setWaitingFor('repository and pull request list');
    setMessage('Opening repository...');

    try {
      const nextRepo = await reviewApi.openRepo(repoPath);
      const savedRepo = normalizeSavedRepo({
        root: nextRepo.root,
        name: repoNameFromPath(nextRepo.root),
        remoteUrl: nextRepo.remoteUrl,
        githubReady: nextRepo.githubReady,
        lastOpenedAt: new Date().toISOString()
      });
      setRepo(nextRepo);
      setSavedRepos((current) => [savedRepo, ...current.filter((item) => item.root !== savedRepo.root)]);
      setActivePullRequest(null);
      setOpeningPullRequestNumber(null);
      setFullContextPullRequest(null);
      setReviewLabelReport(null);
      setPullRequestBrief(null);
      setBriefState('idle');
      setBriefError(null);
      setPullRequestStory(null);
      setStoryState('idle');
      setStoryError(null);
      setStoryPanelOpen(false);
      setActiveLabelId('all');
      setComments([]);
      setExistingComments([]);
      setExpandedFiles(new Set());
      clearLineSelection();

      if (!nextRepo.githubReady) {
        setPullRequests([]);
        setLoadState('idle');
        setMessage('Repository opened, but GitHub auth is not ready.');
        return nextRepo;
      }

      const prs = await reviewApi.listPullRequests(nextRepo.root);
      setPullRequests(prs);

      if (activePrNumber && prs.some((pr) => pr.number === activePrNumber)) {
        await openPullRequest(activePrNumber, nextRepo);
        return nextRepo;
      }

      setLoadState('idle');
      setMessage(`Loaded ${prs.length} pull requests.`);
      setView('workspace');
      return nextRepo;
    } finally {
      setWaitingFor(null);
    }
  }

  async function chooseRepo(): Promise<void> {
    if (!reviewApi) {
      setLoadState('error');
      setMessage('This page is open in a browser. Use the Electron app window to open a local repo.');
      return;
    }
    setLoadState('loading');
    setWaitingFor('repo picker');
    setMessage('Opening repository...');
    try {
      const nextRepo = await reviewApi.chooseRepo();
      if (!nextRepo) {
        setLoadState('idle');
        setMessage('Open a local git repository to start reviewing.');
        return;
      }
      await loadRepo(nextRepo.root);
      setView('workspace');
    } catch (error) {
      setLoadState('error');
      setMessage(error instanceof Error ? error.message : 'Could not open repository.');
    } finally {
      setWaitingFor(null);
    }
  }

  async function refreshPullRequests(): Promise<void> {
    if (!repo || !reviewApi) return;
    setLoadState('loading');
    setWaitingFor('GitHub pull request list');
    setMessage('Loading pull requests...');
    try {
      const prs = await reviewApi.listPullRequests(repo.root);
      setPullRequests(prs);
      setLoadState('idle');
      setMessage(`Loaded ${prs.length} pull requests.`);
    } catch (error) {
      setLoadState('error');
      setMessage(error instanceof Error ? error.message : 'Could not load pull requests.');
    } finally {
      setWaitingFor(null);
    }
  }

  async function openPullRequest(prNumber: number, selectedRepo = repo): Promise<void> {
    if (!selectedRepo || !reviewApi) return;
    const openRequestId = openPullRequestIdRef.current + 1;
    openPullRequestIdRef.current = openRequestId;
    const isCurrentOpenRequest = () => openPullRequestIdRef.current === openRequestId;

    setLoadState('loading');
    setOpeningPullRequestNumber(prNumber);
    setWaitingFor(`PR #${prNumber} worktree and diff`);
    setMessage(`Opening PR #${prNumber} in a worktree...`);
    setView('workspace');
    setActivePullRequest(null);
    setFullContextPullRequest(null);
    setReviewLabelReport(null);
    setComments([]);
    setExistingComments([]);
    setPullRequestBrief(null);
    setBriefState('idle');
    setBriefError(null);
    setPullRequestStory(null);
    setStoryState('idle');
    setStoryError(null);
    setStoryPanelOpen(false);
    setPendingStoryTarget(null);
    setHighlightedStoryTarget(null);
    setActiveLabelId('all');
    setExpandedFiles(new Set());
    clearLineSelection();

    try {
      const opened = await reviewApi.openPullRequest(selectedRepo.root, prNumber, { fullContext: false });
      if (!isCurrentOpenRequest()) return;

      const cacheKey = favoriteKey(selectedRepo.root, prNumber);
      const cachedBrief = preloadedBriefs[cacheKey] ?? null;
      const cachedStory = preloadedStories[cacheKey] ?? null;
      setActivePullRequest(opened);
      setOpeningPullRequestNumber(null);
      setPullRequestBrief(cachedBrief);
      setBriefState(cachedBrief ? 'ready' : 'idle');
      setBriefError(null);
      setPullRequestStory(cachedStory);
      setStoryState(cachedStory ? 'ready' : 'idle');
      setStoryError(null);
      setStoryPanelOpen(false);
      setActiveLabelId('all');
      void reviewApi.saveAppState({
        lastRepoPath: selectedRepo.root,
        activePullRequestNumber: prNumber
      });
      setLoadState('idle');
      setWaitingFor(null);
      setMessage(`PR #${prNumber} ready in ${displaySensitivePath(opened.worktreePath, settings.obfuscatePathsAndUrls)}.`);
      void loadPullRequestDetails(selectedRepo.root, prNumber, openRequestId);
      if (settings.generateBriefOnOpen && !cachedBrief) {
        void loadPullRequestBrief(selectedRepo.root, prNumber, openRequestId);
      }
    } catch (error) {
      if (!isCurrentOpenRequest()) return;
      setOpeningPullRequestNumber(null);
      setLoadState('error');
      setMessage(error instanceof Error ? error.message : `Could not open PR #${prNumber}.`);
    } finally {
      if (isCurrentOpenRequest()) setWaitingFor(null);
    }
  }

  async function loadPullRequestDetails(repoPath: string, prNumber: number, openRequestId: number): Promise<void> {
    if (!reviewApi) return;
    const isCurrentOpenRequest = () => openPullRequestIdRef.current === openRequestId;

    try {
      const [fullContextOpened, labelReport, nextDraftComments, nextExistingComments] = await Promise.all([
        reviewApi.openPullRequest(repoPath, prNumber, { fullContext: true }),
        reviewApi.getReviewLabels(repoPath, prNumber),
        reviewApi.listDraftComments(repoPath, prNumber),
        hasReviewApiMethod(reviewApi, 'listExistingComments')
          ? reviewApi.listExistingComments(repoPath, prNumber)
          : Promise.resolve([])
      ]);

      if (!isCurrentOpenRequest()) return;
      setFullContextPullRequest(fullContextOpened);
      setReviewLabelReport(labelReport);
      setComments(nextDraftComments);
      setExistingComments(nextExistingComments);
    } catch (error) {
      if (!isCurrentOpenRequest()) return;
      setMessage(error instanceof Error ? error.message : `Could not finish loading PR #${prNumber} details.`);
    }
  }

  async function openFavoritePullRequest(favorite: FavoritePullRequest): Promise<void> {
    const selectedRepo = repo?.root === favorite.repoRoot ? repo : await loadRepo(favorite.repoRoot);
    if (!selectedRepo) return;
    await openPullRequest(favorite.number, selectedRepo);
    scrollToDiffViewer();
  }

  async function preloadPullRequestAi(repoRoot: string, pr: Pick<PullRequestSummary, 'number' | 'title'>): Promise<void> {
    if (!reviewApi) return;
    const cacheKey = favoriteKey(repoRoot, pr.number);
    if (preloadStates[cacheKey] === 'loading') return;

    setPreloadStates((current) => ({ ...current, [cacheKey]: 'loading' }));
    setMessage(`Preloading AI context for #${pr.number} ${pr.title}...`);

    try {
      const tasks: Promise<void>[] = [];

      if (settings.generateBriefOnOpen && !preloadedBriefs[cacheKey]) {
        tasks.push(
          reviewApi.getPullRequestBrief(repoRoot, pr.number, { background: true }).then((brief) => {
            setPreloadedBriefs((current) => ({ ...current, [cacheKey]: brief }));
            if (repo?.root === repoRoot && activePullRequest?.number === pr.number) {
              setPullRequestBrief(brief);
              setBriefState('ready');
              setBriefError(null);
            }
          })
        );
      }

      if (settings.generateStoryWithLocalCodex && !preloadedStories[cacheKey] && hasReviewApiMethod(reviewApi, 'getPullRequestStory')) {
        tasks.push(
          reviewApi.getPullRequestStory(repoRoot, pr.number, { background: true }).then((story) => {
            setPreloadedStories((current) => ({ ...current, [cacheKey]: story }));
            if (repo?.root === repoRoot && activePullRequest?.number === pr.number) {
              setPullRequestStory(story);
              setStoryState('ready');
              setStoryError(null);
            }
          })
        );
      }

      if (tasks.length === 0) {
        setPreloadStates((current) => ({ ...current, [cacheKey]: 'ready' }));
        setMessage(`AI context already preloaded for PR #${pr.number}.`);
        return;
      }

      await Promise.all(tasks);
      setPreloadStates((current) => ({ ...current, [cacheKey]: 'ready' }));
      setMessage(`AI context preloaded for PR #${pr.number}.`);
    } catch (error) {
      setPreloadStates((current) => ({ ...current, [cacheKey]: 'error' }));
      setMessage(error instanceof Error ? error.message : `Could not preload AI context for PR #${pr.number}.`);
    }
  }

  function scrollToDiffViewer(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.diff-viewer')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });
  }

  function toggleFavoritePullRequest(pr: PullRequestSummary): void {
    if (!repo) return;
    const key = favoriteKey(repo.root, pr.number);
    setFavoritePullRequests((current) => {
      if (current.some((favorite) => favoriteKey(favorite.repoRoot, favorite.number) === key)) {
        return current.filter((favorite) => favoriteKey(favorite.repoRoot, favorite.number) !== key);
      }
      return [makeFavoritePullRequest(repo, pr), ...current];
    });
  }

  function removeFavoritePullRequest(favorite: FavoritePullRequest): void {
    const key = favoriteKey(favorite.repoRoot, favorite.number);
    setFavoritePullRequests((current) =>
      current.filter((item) => favoriteKey(item.repoRoot, item.number) !== key)
    );
  }

  function updateSettings(nextSettings: Required<AppSettings>): void {
    setSettings(nextSettings);
    if (nextSettings.obfuscatePathsAndUrls && activePullRequest) {
      setMessage(`PR #${activePullRequest.number} ready in ${displaySensitivePath(activePullRequest.worktreePath, true)}.`);
    }
  }

  async function loadPullRequestBrief(repoPath: string, prNumber: number, openRequestId?: number): Promise<void> {
    if (!reviewApi) return;
    const isCurrentOpenRequest = () => openRequestId === undefined || openPullRequestIdRef.current === openRequestId;

    if (isCurrentOpenRequest()) {
      setBriefState('loading');
      setBriefError(null);
      setWaitingFor(`local Codex brief for PR #${prNumber}`);
    }
    try {
      const brief = await reviewApi.getPullRequestBrief(repoPath, prNumber);
      if (!isCurrentOpenRequest()) return;
      setPullRequestBrief(brief);
      setPreloadedBriefs((current) => ({ ...current, [favoriteKey(repoPath, prNumber)]: brief }));
      setBriefState('ready');
      setBriefError(null);
    } catch (error) {
      if (!isCurrentOpenRequest()) return;
      setPullRequestBrief(null);
      setBriefState('error');
      setBriefError(error instanceof Error ? error.message : 'Could not generate the PR brief.');
    } finally {
      if (isCurrentOpenRequest()) {
        setWaitingFor(null);
      }
    }
  }

  async function openPullRequestStory(): Promise<void> {
    if (!repo || !activePullRequest || !reviewApi) return;
    setStoryPanelOpen(true);
    if (pullRequestStory || storyState === 'loading') return;
    if (!settings.generateStoryWithLocalCodex) {
      setStoryState('error');
      setStoryError('Product Story generation is disabled in Settings.');
      return;
    }

    const storyRequestId = storyRequestIdRef.current + 1;
    storyRequestIdRef.current = storyRequestId;
    const requestedRepoRoot = repo.root;
    const requestedPrNumber = activePullRequest.number;
    const isCurrentStoryRequest = () =>
      storyRequestIdRef.current === storyRequestId &&
      repo?.root === requestedRepoRoot &&
      activePullRequest?.number === requestedPrNumber;

    setStoryState('loading');
    setStoryError(null);
    setWaitingFor(`local Codex Product Story for #${requestedPrNumber}`);
    try {
      if (!hasReviewApiMethod(reviewApi, 'getPullRequestStory')) {
        throw new Error('Restart the Electron app to load Product Story support.');
      }

      const story = await reviewApi.getPullRequestStory(requestedRepoRoot, requestedPrNumber);
      if (!isCurrentStoryRequest()) return;
      setPullRequestStory(story);
      setPreloadedStories((current) => ({ ...current, [favoriteKey(requestedRepoRoot, requestedPrNumber)]: story }));
      setPreloadStates((current) => ({ ...current, [favoriteKey(requestedRepoRoot, requestedPrNumber)]: 'ready' }));
      setStoryState('ready');
    } catch (error) {
      if (!isCurrentStoryRequest()) return;
      setPullRequestStory(null);
      setStoryState('error');
      setStoryError(error instanceof Error ? error.message : 'Could not build the Product Story.');
    } finally {
      if (isCurrentStoryRequest()) {
        setWaitingFor(null);
      }
    }
  }

  function toggleFileContext(filePath: string): void {
    setExpandedFiles((current) => {
      const next = new Set(current);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }

  function expandAllFiles(): void {
    setExpandedFiles(new Set(activeDiffFilePaths));
  }

  function compactAllFiles(): void {
    setExpandedFiles(new Set());
  }

  function scrollToDiffFile(filePath: string): void {
    requestAnimationFrame(() => {
      const fileElement = Array.from(document.querySelectorAll<HTMLElement>('.diff-file')).find(
        (element) => element.dataset.filePath === filePath
      );
      fileElement?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  function scrollToRenderedStoryTarget(target: ResolvedStoryDiffTarget): boolean {
    const lineElement = Array.from(document.querySelectorAll<HTMLElement>('[data-diff-line-anchor="true"]')).find(
      (element) =>
        element.dataset.filePath === target.filePath &&
        element.dataset.side === target.side &&
        Number(element.dataset.line) === target.line
    );

    if (lineElement) {
      (lineElement.closest('tr') ?? lineElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    }

    const fileElement = Array.from(document.querySelectorAll<HTMLElement>('.diff-file')).find(
      (element) => element.dataset.filePath === target.filePath
    );
    fileElement?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return !target.line && Boolean(fileElement);
  }

  function openStoryDiffTarget(target: PullRequestStoryDiffTarget): void {
    const resolvedTarget = resolveStoryDiffTarget(target, storyDiffTargetFilePaths);
    setStoryPanelOpen(false);
    setActiveLabelId('all');
    setExpandedFiles((current) => new Set(current).add(resolvedTarget.filePath));
    setPendingStoryTarget(resolvedTarget);
    setHighlightedStoryTarget(resolvedTarget);
    if (!scrollToRenderedStoryTarget(resolvedTarget)) scrollToDiffFile(resolvedTarget.filePath);
    setMessage(`Opened ${resolvedTarget.filePath}${resolvedTarget.line ? `:${resolvedTarget.line}` : ''} from Product Story.`);
  }

  async function addComment(target: CommentTarget): Promise<void> {
    if (!repo || !activePullRequest || !reviewApi) return;
    const comment = makeDraftComment(activePullRequest.number, target);
    const saved = await reviewApi.saveDraftComment(repo.root, comment);
    setComments((current) => current.concat(saved));
  }

  async function addSummaryComment(): Promise<void> {
    if (!repo || !activePullRequest || !reviewApi) return;
    const comment = makeSummaryComment(activePullRequest.number);
    const saved = await reviewApi.saveDraftComment(repo.root, comment);
    setComments((current) => current.concat(saved));
  }

  function startLineSelection(target: CommentTarget): void {
    const selection = {
      filePath: target.filePath,
      side: target.side,
      startLine: target.line,
      endLine: target.line
    };
    lineSelectionRef.current = selection;
    setLineSelection(selection);
  }

  function previewLineSelection(target: CommentTarget): void {
    const current = lineSelectionRef.current;
    if (!current || current.filePath !== target.filePath || current.side !== target.side) return;

    const next = {
      ...current,
      endLine: target.line
    };
    lineSelectionRef.current = next;
    setLineSelection(next);
  }

  function clearLineSelection(): void {
    lineSelectionRef.current = null;
    setLineSelection(null);
  }

  async function commitLineSelection(): Promise<void> {
    if (!repo || !activePullRequest || !reviewApi) return;

    const selection = lineSelectionRef.current;
    if (!selection) {
      clearLineSelection();
      return;
    }

    const comment = makeCommentFromSelection(activePullRequest.number, selection);
    const saved = await reviewApi.saveDraftComment(repo.root, comment);

    setComments((current) => current.concat(saved));
    clearLineSelection();
  }

  async function updateComment(comment: DraftComment, body: string): Promise<void> {
    if (!repo || !reviewApi) return;
    const nextStatus = comment.githubCommentId && comment.status !== 'deleted' ? 'stale' : 'draft';
    const next = { ...comment, body, status: nextStatus as 'draft' | 'stale', updatedAt: new Date().toISOString() };
    await reviewApi.saveDraftComment(repo.root, next);
    setComments((current) => current.map((item) => (item.id === next.id ? next : item)));
  }

  async function deleteComment(comment: DraftComment): Promise<void> {
    if (!repo || !reviewApi) return;
    setComments(await reviewApi.deleteDraftComment(repo.root, comment.prNumber, comment.id));
  }

  async function syncComments(): Promise<void> {
    if (!repo || !activePullRequest || !reviewApi) return;
    setLoadState('loading');
    setWaitingFor('GitHub comment sync');
    setMessage('Syncing draft comments to GitHub...');
    try {
      setComments(await reviewApi.syncDraftComments(repo.root, activePullRequest.number));
      if (hasReviewApiMethod(reviewApi, 'listExistingComments')) {
        setExistingComments(await reviewApi.listExistingComments(repo.root, activePullRequest.number));
      }
      clearLineSelection();
      setLoadState('idle');
      setMessage('Draft comments synced.');
    } catch (error) {
      setLoadState('error');
      setMessage(error instanceof Error ? error.message : 'Could not sync comments.');
    } finally {
      setWaitingFor(null);
    }
  }

  async function checkCommentResolutions(): Promise<void> {
    if (!repo || !activePullRequest || !reviewApi) return;
    if (!settings.checkResolutionWithLocalCodex) {
      setLoadState('error');
      setMessage('Local Codex resolution checks are disabled in Settings.');
      return;
    }
    setLoadState('loading');
    setWaitingFor('local Codex comment resolution check');
    setMessage('Checking comments with local Codex...');
    try {
      setComments(await reviewApi.checkCommentResolutions(repo.root, activePullRequest.number));
      setLoadState('idle');
      setMessage('Comment resolution check complete.');
    } catch (error) {
      setLoadState('error');
      setMessage(error instanceof Error ? error.message : 'Could not check comment resolution.');
    } finally {
      setWaitingFor(null);
    }
  }

  function startResize(side: ResizeSide, startX: number): void {
    if ((side === 'left' && leftSidebarCollapsed) || (side === 'right' && rightSidebarCollapsed)) {
      return;
    }

    const startLeft = leftSidebarWidth;
    const startRight = rightSidebarWidth;

    function onPointerMove(event: PointerEvent): void {
      const delta = event.clientX - startX;
      if (side === 'left') {
        setLeftSidebarWidth(clamp(startLeft + delta, 220, 460));
      } else {
        setRightSidebarWidth(clamp(startRight - delta, 260, 520));
      }
    }

    function onPointerUp(): void {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.classList.remove('is-resizing');
    }

    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="topbar-main">
          <Button
            type="button"
            onClick={() => setView('home')}
            variant="outline"
            className={view === 'home' ? 'topbar-button is-active' : 'topbar-button'}
          >
            <Home size={16} />
            Home
          </Button>
          <div>
            <p className="eyebrow">Local PR Review</p>
            <h1>{view === 'home' ? 'Review Home' : view === 'settings' ? 'Settings' : 'PR Workspace'}</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <Button
            type="button"
            onClick={() => setView('settings')}
            variant="outline"
            className={view === 'settings' ? 'topbar-button is-active' : 'topbar-button'}
          >
            <Settings size={16} />
            Settings
          </Button>
          {view === 'workspace' && leftSidebarCollapsed ? (
            <Button
              type="button"
              onClick={() => setLeftSidebarCollapsed(false)}
              variant="outline"
              title="Show pull request list"
              aria-label="Show pull request list"
            >
              <PanelLeftOpen size={16} />
              PRs
            </Button>
          ) : null}
          {view === 'workspace' && rightSidebarCollapsed ? (
            <Button
              type="button"
              onClick={() => setRightSidebarCollapsed(false)}
              variant="outline"
              title="Show comments panel"
              aria-label="Show comments panel"
            >
              <PanelRightOpen size={16} />
              Comments
            </Button>
          ) : null}
          <div className="theme-control">
            <Sun size={15} />
            <Switch
              checked={theme === 'dark'}
              onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
              aria-label="Toggle dark mode"
            />
            <Moon size={15} />
          </div>
          <Button
            type="button"
            onClick={chooseRepo}
            disabled={loadState === 'loading'}
            variant="outline"
            className="topbar-button"
          >
            <FolderOpen size={16} />
            Open Repo
          </Button>
          <Button
            type="button"
            onClick={refreshPullRequests}
            disabled={!repo || loadState === 'loading'}
            variant="outline"
            className="topbar-button"
          >
            <RefreshCw size={16} />
            Refresh PRs
          </Button>
        </div>
      </header>

      <section className={`status-line ${loadState === 'error' ? 'is-error' : ''}`}>
        <span>
          {reviewApi
            ? message
            : 'Browser preview only. Open the Electron app window to use local repo and GitHub features.'}
        </span>
        {repo ? <span>{displaySensitivePath(repo.root, settings.obfuscatePathsAndUrls)}</span> : null}
      </section>

      {view === 'home' ? (
        <HomeDashboard
          savedRepos={savedRepos}
          favorites={favoritePullRequests}
          activeRepoRoot={repo?.root ?? null}
          loadState={loadState}
          obfuscatePathsAndUrls={settings.obfuscatePathsAndUrls}
          preloadStates={preloadStates}
          onChooseRepo={() => void chooseRepo()}
          onOpenRepo={(repoRoot) => void loadRepo(repoRoot)}
          onOpenFavorite={(favorite) => void openFavoritePullRequest(favorite)}
          onPreloadFavorite={(favorite) => void preloadPullRequestAi(favorite.repoRoot, favorite)}
          onRemoveFavorite={removeFavoritePullRequest}
        />
      ) : null}

      {view === 'settings' ? (
        <SettingsPanel settings={settings} onUpdateSettings={updateSettings} />
      ) : null}

      {view === 'workspace' ? (
      <section
        className={[
          'workspace-grid',
          leftSidebarCollapsed ? 'is-left-collapsed' : '',
          rightSidebarCollapsed ? 'is-right-collapsed' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          gridTemplateColumns: `${leftSidebarCollapsed ? 0 : leftSidebarWidth}px ${
            leftSidebarCollapsed ? 0 : 6
          }px minmax(420px, 1fr) ${rightSidebarCollapsed ? 0 : 6}px ${
            rightSidebarCollapsed ? 0 : rightSidebarWidth
          }px`
        }}
      >
        <aside className="pr-list panel-shell" aria-hidden={leftSidebarCollapsed} aria-label="Pull requests">
          <CardHeader className="panel-header">
            <div className="panel-title">
              <h2>Pull Requests</h2>
              <span>{pullRequests.length}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setLeftSidebarCollapsed(true)}
              title="Collapse pull request list"
              aria-label="Collapse pull request list"
            >
              <PanelLeftClose size={16} />
            </Button>
          </CardHeader>
          <CardContent className="pr-list-body">
            {pullRequests.map((pr) => {
              const isFavorite =
                repo &&
                favoritePullRequests.some(
                  (favorite) => favoriteKey(favorite.repoRoot, favorite.number) === favoriteKey(repo.root, pr.number)
                );
              const isOpening = openingPullRequestNumber === pr.number;
              const isActive = activePullRequest?.number === pr.number || isOpening;

              return (
                <div className={isActive ? 'pr-row-wrap is-active' : 'pr-row-wrap'} key={pr.number}>
                  <Button
                    className="pr-row"
                    type="button"
                    variant="ghost"
                    onClick={() => void openPullRequest(pr.number)}
                  >
                    <span className="pr-row-main">
                      <strong>{pr.title}</strong>
                      {pr.source === 'mock' ? <span className="source-pill">Mock</span> : null}
                      <span className="pr-number">
                        <GitPullRequest size={14} />
                        #{pr.number}
                      </span>
                      {isOpening ? <Loader2 className="pr-row-spinner" size={14} aria-label="Opening PR" /> : null}
                    </span>
                    <small>
                      {pr.headRefName} into {pr.baseRefName}
                    </small>
                  </Button>
                  <PreloadButton
                    state={repo ? preloadStates[favoriteKey(repo.root, pr.number)] ?? 'idle' : 'idle'}
                    onClick={() => repo && void preloadPullRequestAi(repo.root, pr)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={isFavorite ? 'favorite-toggle is-active' : 'favorite-toggle'}
                    onClick={() => toggleFavoritePullRequest(pr)}
                    title={isFavorite ? 'Remove favorite' : 'Favorite PR'}
                    aria-label={isFavorite ? 'Remove favorite' : 'Favorite PR'}
                  >
                    <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
                  </Button>
                </div>
              );
            })}
            {pullRequests.length === 0 ? <p className="empty-state">No pull requests loaded.</p> : null}
          </CardContent>
        </aside>

        <div
          className="resize-handle"
          role="separator"
          aria-label="Resize pull request list"
          aria-orientation="vertical"
          onPointerDown={(event) => startResize('left', event.clientX)}
        />

        <section className="diff-workspace">
          <CardHeader className="panel-header">
            <div>
              <h2>{activePullRequest ? `#${activePullRequest.number} ${activePullRequest.title}` : 'Diff'}</h2>
              {activePullRequest ? (
                <p>
                  {activePullRequest.headRefName} into {activePullRequest.baseRefName}
                </p>
              ) : null}
            </div>
            <div className="diff-header-actions">
              {activePullRequest ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={activePrIsFavorite ? 'favorite-toggle is-active' : 'favorite-toggle'}
                    onClick={() => toggleFavoritePullRequest(activePullRequest)}
                    title={activePrIsFavorite ? 'Remove favorite' : 'Favorite PR'}
                    aria-label={activePrIsFavorite ? 'Remove favorite' : 'Favorite PR'}
                  >
                    <Star size={16} fill={activePrIsFavorite ? 'currentColor' : 'none'} />
                    {activePrIsFavorite ? 'Favorited' : 'Favorite'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void openPullRequestStory()}
                  >
                    <BookOpen size={14} />
                    Product Story
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={expandAllFiles}>
                    <Maximize2 size={14} />
                    Expand all
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={compactAllFiles}>
                    <Minimize2 size={14} />
                    Compact all
                  </Button>
                </>
              ) : null}
              <span>{comments.length} local comments</span>
            </div>
          </CardHeader>
          {activePullRequest ? (
            <PullRequestBriefPanel brief={pullRequestBrief} briefState={briefState} error={briefError} />
          ) : null}
          {activePullRequest ? (
            <ReviewLabelSummary
              report={reviewLabelReport}
              activeLabelId={activeLabelId}
              onActiveLabelChange={setActiveLabelId}
            />
          ) : null}
          <div className="diff-surface">
            {activePullRequest ? (
              <DiffViewer
                diff={activePullRequest.diff}
                fullContextDiff={fullContextPullRequest?.diff ?? null}
                comments={comments}
                labelReport={reviewLabelReport}
                activeLabelId={activeLabelId}
                expandedFiles={expandedFiles}
                highlightedStoryTarget={highlightedStoryTarget}
                lineSelection={lineSelection}
                onAddComment={(target) => void addComment(target)}
                onStartLineSelection={startLineSelection}
                onPreviewLineSelection={previewLineSelection}
                onCommitLineSelection={() => void commitLineSelection()}
                onUpdateComment={(comment, body) => void updateComment(comment, body)}
                onDeleteComment={(comment) => void deleteComment(comment)}
                onToggleFileContext={toggleFileContext}
              />
            ) : (
              <div className="diff-empty">
                {openingPullRequestNumber
                  ? `Opening PR #${openingPullRequestNumber} and preparing its diff...`
                  : 'Open a PR to create a worktree and show its diff against the base branch.'}
              </div>
            )}
          </div>
        </section>

        <div
          className="resize-handle"
          role="separator"
          aria-label="Resize comments panel"
          aria-orientation="vertical"
          onPointerDown={(event) => startResize('right', event.clientX)}
        />

        <aside className="comments-panel panel-shell" aria-hidden={rightSidebarCollapsed} aria-label="Review comments">
          <CardHeader className="panel-header">
            <div className="panel-title">
              <h2>Comments</h2>
              <span>
                {existingComments.length} existing · {pendingSyncCount} unsynced
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setRightSidebarCollapsed(true)}
              title="Collapse comments panel"
              aria-label="Collapse comments panel"
            >
              <PanelRightClose size={16} />
            </Button>
          </CardHeader>
          <div className="summary-actions">
            <Button type="button" variant="outline" size="sm" disabled={!activePullRequest} onClick={() => void addSummaryComment()}>
              Add summary
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activePullRequest || comments.length === 0 || loadState === 'loading' || !settings.checkResolutionWithLocalCodex}
              onClick={() => void checkCommentResolutions()}
              title={settings.checkResolutionWithLocalCodex ? 'Check comment resolution' : 'Enabled in Settings'}
            >
              <Radar size={14} />
              Check resolution
            </Button>
          </div>
          <CardContent className="comments-body">
            <div className="comments-section">
              <div className="comments-section-header">
                <strong>Existing PR comments</strong>
                <span>{existingComments.length}</span>
              </div>
              {existingComments.map((comment) => (
                <Card className="comment-card existing-comment-card" key={comment.id}>
                  <div className="comment-meta">
                    <span className="status-pill">Existing</span>
                    <span>{comment.author}</span>
                  </div>
                  <small>{existingCommentLocationLabel(comment)}</small>
                  <p>{comment.body || 'Empty comment'}</p>
                  {comment.url ? (
                    <a className="comment-link" href={comment.url}>
                      {settings.obfuscatePathsAndUrls ? 'Open source comment' : 'Open on GitHub'}
                    </a>
                  ) : null}
                </Card>
              ))}
              {existingComments.length === 0 ? <p className="empty-state">No existing PR comments.</p> : null}
            </div>
            <div className="comments-section">
              <div className="comments-section-header">
                <strong>Local drafts</strong>
                <span>{comments.length}</span>
              </div>
            {comments.map((comment) => (
              <Card className={comment.status === 'deleted' ? 'comment-card is-delete-pending' : 'comment-card'} key={comment.id}>
                <div className="comment-meta">
                  <span className={commentStatusClassName(comment)}>{commentStatusLabel(comment)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => void deleteComment(comment)}
                    title="Delete local comment"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                <small>{commentLocationLabel(comment)}</small>
                {comment.type === 'summary' && comment.status !== 'deleted' ? (
                  <Textarea
                    value={comment.body}
                    onChange={(event) => void updateComment(comment, event.target.value)}
                    placeholder="Write a summary comment..."
                  />
                ) : (
                  <p className={comment.status === 'deleted' ? 'is-deleted-comment' : undefined}>
                    {comment.body || 'Empty draft'}
                  </p>
                )}
                {comment.type !== 'summary' ? (
                  <div className="resolution-status">
                    <span className={resolutionStatusClassName(comment)}>{resolutionStatusLabel(comment)}</span>
                    {comment.resolution?.reason ? <p>{comment.resolution.reason}</p> : null}
                  </div>
                ) : null}
              </Card>
            ))}
            {comments.length === 0 ? <p className="empty-state">No local comments yet.</p> : null}
            <Button
              type="button"
              className="sync-button"
              disabled={!activePullRequest || pendingSyncCount === 0}
              onClick={syncComments}
            >
              {syncButtonLabel}
            </Button>
            </div>
          </CardContent>
        </aside>
      </section>
      ) : null}

      {waitingFor ? (
        <div className="waiting-toast" role="status" aria-live="polite">
          <Loader2 size={16} />
          <div>
            <strong>Waiting for {waitingFor}</strong>
            <span>This can take a moment.</span>
          </div>
        </div>
      ) : null}

      {storyPanelOpen ? (
        <PullRequestStoryPanel
          story={pullRequestStory}
          storyState={storyState}
          error={storyError}
          obfuscatePathsAndUrls={settings.obfuscatePathsAndUrls}
          onOpenDiffTarget={openStoryDiffTarget}
          onClose={() => setStoryPanelOpen(false)}
        />
      ) : null}
    </main>
  );
}

export default function App(): ReactElement {
  return (
    <ErrorBoundary>
      <ReviewApp />
    </ErrorBoundary>
  );
}
