import { contextBridge, ipcRenderer } from 'electron';
import type { DraftComment, ReviewApi } from '../shared/types';

const api: ReviewApi = {
  chooseRepo: () => ipcRenderer.invoke('repo:choose'),
  openRepo: (path) => ipcRenderer.invoke('repo:open', path),
  listDemoRepos: () => ipcRenderer.invoke('demo-repos:list'),
  listPullRequests: (repoPath) => ipcRenderer.invoke('prs:list', repoPath),
  openPullRequest: (repoPath, prNumber, options) => ipcRenderer.invoke('pr:open', repoPath, prNumber, options),
  listExistingComments: (repoPath, prNumber) => ipcRenderer.invoke('comments:existing', repoPath, prNumber),
  listDraftComments: (repoPath, prNumber) => ipcRenderer.invoke('comments:list', repoPath, prNumber),
  saveDraftComment: (repoPath, comment: DraftComment) => ipcRenderer.invoke('comments:save', repoPath, comment),
  deleteDraftComment: (repoPath, prNumber, commentId) => ipcRenderer.invoke('comments:delete', repoPath, prNumber, commentId),
  syncDraftComments: (repoPath, prNumber) => ipcRenderer.invoke('comments:sync', repoPath, prNumber),
  checkCommentResolutions: (repoPath, prNumber) => ipcRenderer.invoke('comments:check-resolutions', repoPath, prNumber),
  getReviewLabels: (repoPath, prNumber) => ipcRenderer.invoke('labels:get', repoPath, prNumber),
  getPullRequestBrief: (repoPath, prNumber, options) => ipcRenderer.invoke('pr:brief', repoPath, prNumber, options),
  getPullRequestStory: (repoPath, prNumber, options) => ipcRenderer.invoke('pr:story', repoPath, prNumber, options),
  getAppState: () => ipcRenderer.invoke('app-state:get'),
  saveAppState: (state) => ipcRenderer.invoke('app-state:save', state)
};

contextBridge.exposeInMainWorld('reviewApi', api);
