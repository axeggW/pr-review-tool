# Product Story Guides

The PR review tool can use an optional repository guide when generating the click-through Product Story preflight.

Add one of these files to the repository being reviewed:

- `.pr-review-tool/pr-story-guide.md`
- `.pr-review-tool/review-guide.md`
- `PR_REVIEW_GUIDE.md`

The guide should describe how reviewers on that repo think about changes. Keep it specific and operational.

Useful prompts to include:

- Which areas are production-critical?
- Which files are generated, fixture-only, or low-risk?
- Which labels or review stages matter to the team?
- What should a lead reviewer always check before approval?
- What code fragments are most useful in the Product Story?
- Which files or lines should become Open Diff targets?

Example:

```md
# Product Story Guide

When generating a Product Story for this repository:

- Start with user-facing behavior and runtime risk.
- Separate app logic from test fixtures and docs.
- Include code fragments for changed public APIs, migration paths, and config changes.
- Call out files that are generated or safe to skim.
- End with a prioritized review path for correctness, rollout, and follow-up work.
```

The guide is read locally and passed to local Codex alongside the diff, deterministic labels, existing PR comments, and local draft comment state.
