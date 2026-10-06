// Uses only the native Codex GitHub review. No OpenAI API key or model call.
const [owner, repo] = process.env.GH_REPOSITORY.split('/');
const token = process.env.GH_TOKEN;
const bot = 'chatgpt-codex-connector[bot]';
const context = 'Codex Code Review';

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

async function allPages(path) {
  const result = [];
  for (let page = 1; ; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await api(`${path}${separator}per_page=100&page=${page}`);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
}

function completedReview(comments, sha) {
  const summary = comments
    .filter((comment) => comment.user?.login === bot &&
      comment.body?.startsWith('<!-- codex-pull-request-review-summary -->'))
    .at(-1);
  if (!summary) return null;
  const row = summary.body.split('\n').find((line) =>
    line.includes('| 📝 **Code Review** | ✅ **Completed**'));
  if (!row) return null;
  const reviewed = row.match(/\|\s*`([0-9a-f]{7,40})`\s*\|/i)?.[1];
  const completed = row.match(/datetime="([^"]+)"/)?.[1];
  if (!reviewed || !completed || !sha.startsWith(reviewed)) return null;
  return { completed: Date.parse(completed), manual: row.includes('| Manual request |') };
}

async function processPr(pr) {
  if (pr.draft || pr.state !== 'open') return;
  const number = pr.number;
  const sha = pr.head.sha;
  const issuePath = `/repos/${owner}/${repo}/issues/${number}`;
  const [comments, reviews] = await Promise.all([
    allPages(`${issuePath}/comments`),
    allPages(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
  ]);
  const review = completedReview(comments, sha);
  const request = review?.manual && comments
    .filter((comment) => comment.body?.trim() === '@codex review' &&
      Date.parse(comment.created_at) <= review.completed)
    .at(-1);
  const reactionPath = review?.manual
    ? request && `/repos/${owner}/${repo}/issues/comments/${request.id}/reactions`
    : `${issuePath}/reactions`;
  const reactions = reactionPath ? await allPages(reactionPath) : [];
  const reviewStarted = Date.parse(review?.manual ? request?.created_at : pr.created_at);
  const hasFindings = reviews.some((entry) =>
    entry.user?.login === bot && entry.commit_id === sha &&
    entry.state === 'COMMENTED' &&
    Date.parse(entry.submitted_at) >= reviewStarted &&
    Date.parse(entry.submitted_at) <= review?.completed);
  const clean = !hasFindings && Number.isFinite(review?.completed) && reactions.some((reaction) =>
    reaction.user?.login === bot && reaction.content === '+1' &&
    Date.parse(reaction.created_at) >= review.completed);
  const statuses = await api(`/repos/${owner}/${repo}/commits/${sha}/status`);
  const previous = statuses.statuses.find((status) => status.context === context);
  let currentState = previous?.state;
  let currentDescription = previous?.description;
  async function setStatus(state, description) {
    if (currentState === state && currentDescription === description) return;
    await api(`/repos/${owner}/${repo}/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({ state, context, description, target_url: pr.html_url }),
    });
    currentState = state;
    currentDescription = description;
  }
  if (!clean) {
    await setStatus('pending', 'Waiting for a clean native Codex review of this commit');
    console.log(`#${number} ${sha.slice(0, 7)}: waiting for Codex`);
    return;
  }

  if (!pr.auto_merge) {
    // Keep the required gate pending until GitHub has scheduled auto-merge.
    await setStatus('pending', 'Clean Codex review; scheduling auto-merge');
    const result = await api('/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH}) { pullRequest { number } } }',
        variables: { id: pr.node_id },
      }),
    });
    if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
    console.log(`#${number}: GitHub auto-merge enabled`);
  }
  await setStatus('success', 'Codex completed this commit review with no findings');
  console.log(`#${number} ${sha.slice(0, 7)}: clean Codex review`);
}

const event = JSON.parse(await (await import('node:fs/promises')).readFile(process.env.EVENT_PATH, 'utf8'));
let prs;
if (process.env.EVENT_NAME === 'schedule' || process.env.EVENT_NAME === 'workflow_dispatch') {
  prs = await allPages(`/repos/${owner}/${repo}/pulls?state=open`);
} else if (process.env.EVENT_NAME === 'issue_comment' && event.issue?.pull_request) {
  prs = [await api(`/repos/${owner}/${repo}/pulls/${event.issue.number}`)];
} else if (event.pull_request) {
  prs = [await api(`/repos/${owner}/${repo}/pulls/${event.pull_request.number}`)];
} else {
  prs = [];
}

for (const pr of prs) await processPr(pr);
