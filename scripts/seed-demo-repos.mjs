import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(root, '.demo-repos');

const repos = [
  {
    name: 'vite',
    url: 'https://github.com/vitejs/vite.git',
    number: 9001,
    branch: 'demo/pr-review-runtime-config',
    title: 'Demo: add runtime review checklist'
  },
  {
    name: 'express',
    url: 'https://github.com/expressjs/express.git',
    number: 9002,
    branch: 'demo/pr-review-routing-notes',
    title: 'Demo: clarify routing review fixtures'
  },
  {
    name: 'lodash',
    url: 'https://github.com/lodash/lodash.git',
    number: 9003,
    branch: 'demo/pr-review-helper-tags',
    title: 'Demo: add helper review labels'
  }
];

function run(command, args, cwd = root) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter)
    }
  });
}

function tryRun(command, args, cwd = root) {
  try {
    run(command, args, cwd);
  } catch {
    return false;
  }
  return true;
}

function output(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter)
    }
  }).trim();
}

function defaultBranch(repoPath) {
  try {
    return output('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], repoPath).replace(/^origin\//, '');
  } catch {
    return existsSync(path.join(repoPath, 'master')) ? 'master' : 'main';
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendDemoSection(repoPath, repoName) {
  const readmePath = ['README.md', 'Readme.md', 'readme.md'].map((file) => path.join(repoPath, file)).find(existsSync);
  if (!readmePath) return null;

  const current = readFileSync(readmePath, 'utf8');
  const marker = '<!-- pr-review-tool-demo -->';
  const next = `${current.replace(new RegExp(`\\n*${marker}[\\s\\S]*$`), '')}

${marker}

## PR Review Tool Demo Notes

- Adds deterministic review labels for docs, tests, helpers, and human-review paths.
- Seeds a local mock PR branch in ${repoName} without touching upstream GitHub state.
- Gives reviewers a multi-file diff with enough surface area for line, block, and summary comments.
`;

  writeFileSync(readmePath, next);
  return path.relative(repoPath, readmePath);
}

function seedRepo(repo) {
  const repoPath = path.join(demoRoot, repo.name);
  if (!existsSync(repoPath)) {
    run('git', ['clone', '--depth=1', repo.url, repoPath]);
  }

  run('git', ['config', 'user.name', 'PR Review Demo'], repoPath);
  run('git', ['config', 'user.email', 'demo@pr-review-tool.local'], repoPath);
  run('git', ['fetch', '--depth=1', 'origin'], repoPath);

  const base = defaultBranch(repoPath);
  run('git', ['checkout', base], repoPath);
  tryRun('git', ['branch', '-D', repo.branch], repoPath);
  run('git', ['checkout', '-b', repo.branch], repoPath);

  mkdirSync(path.join(repoPath, 'docs', 'pr-review-demo'), { recursive: true });
  mkdirSync(path.join(repoPath, '.pr-review-tool'), { recursive: true });

  const readmeFile = appendDemoSection(repoPath, repo.name);
  writeFileSync(
    path.join(repoPath, 'docs', 'pr-review-demo', 'review-checklist.md'),
    `# ${repo.name} Review Checklist

- Confirm the documentation change matches the intended reviewer workflow.
- Check whether the label rules catch docs, tests, helpers, and package metadata.
- Leave a block comment over this checklist to test range comments.
- Sync the local draft comments to exercise the demo flow.
`
  );
  writeJson(path.join(repoPath, 'docs', 'pr-review-demo', 'sample-review-state.json'), {
    repository: repo.name,
    reviewMode: 'local-demo',
    steps: ['open repo', 'open mock PR', 'leave line comment', 'leave block comment', 'sync comments']
  });
  writeJson(path.join(repoPath, 'review-labels.json'), {
    labels: [
      {
        id: 'needs-human-review',
        name: 'Needs human review',
        color: '#f85149',
        rules: [{ paths: ['README.md', 'docs/**'] }]
      },
      {
        id: 'docs',
        name: 'Docs',
        color: '#2ea043',
        rules: [{ paths: ['**/*.md'] }]
      },
      {
        id: 'config',
        name: 'Config',
        color: '#d29922',
        rules: [{ paths: ['review-labels.json', 'package.json'] }]
      },
      {
        id: 'new-files',
        name: 'New files',
        color: '#388bfd',
        rules: [{ changeTypes: ['added'] }]
      }
    ]
  });
  writeFileSync(
    path.join(repoPath, '.pr-review-tool', 'pr-story-guide.md'),
    `# Product Story Guide

When generating a Product Story for this repository:

- Start with the reviewer workflow impact, not the changed file list.
- Separate documentation/config changes from runtime behavior changes.
- Include compact code fragments that prove the change, especially new files and label config.
- Add Open Diff targets for the exact files and lines that deserve human inspection.
- Call out whether the PR is safe demo scaffolding or affects production behavior.
- End with a prioritized review path a lead reviewer can execute quickly.
`
  );

  if (existsSync(path.join(repoPath, 'package.json'))) {
    const packageJsonPath = path.join(repoPath, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    packageJson.prReviewToolDemo = {
      enabled: true,
      labelConfig: 'review-labels.json'
    };
    writeJson(packageJsonPath, packageJson);
  }

  run('git', ['add', ...[readmeFile].filter(Boolean), 'docs/pr-review-demo', 'review-labels.json', 'package.json'], repoPath);
  tryRun('git', ['commit', '-m', repo.title], repoPath);

  writeJson(path.join(repoPath, '.pr-review-tool', 'mock-prs.json'), [
    {
      number: repo.number,
      title: repo.title,
      author: 'local-demo',
      headRefName: repo.branch,
      baseRefName: base,
      isDraft: false,
      reviewDecision: null,
      updatedAt: new Date().toISOString(),
      url: `mock://${repo.name}/pull/${repo.number}`,
      source: 'mock'
    }
  ]);

  console.log(`${repo.name}: ${repoPath}`);
}

mkdirSync(demoRoot, { recursive: true });

for (const repo of repos) {
  seedRepo(repo);
}

console.log(`Demo repos ready in ${demoRoot}`);
