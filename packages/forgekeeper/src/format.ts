import { automatedReview } from './automated-review-watch';
import {
  yesNo,
  type GitLabMergeRequest,
  type Indicator,
  type Pipeline,
  type ReviewRequest,
  type Tone,
} from './forge';
import { reference, traitsOf } from './forges';
import type { Snapshot } from './store';

export type { Tone };
export type Segment = Indicator;

const RUNNING = new Set([
  'CREATED',
  'WAITING_FOR_RESOURCE',
  'PREPARING',
  'PENDING',
  'RUNNING',
  'SCHEDULED',
  'WAITING_FOR_CALLBACK',
  'CANCELING',
]);

export function pipelineTone(pipeline: Pipeline | undefined): Tone {
  if (!pipeline) return 'muted';
  if (pipeline.status === 'FAILED') return 'error';
  if (pipeline.status === 'SUCCESS')
    return pipeline.label.includes('warning') ? 'warning' : 'success';
  if (RUNNING.has(pipeline.status)) return 'warning';
  return 'muted';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const COMPACT_CI: Partial<Record<Tone, string>> = {
  success: 'CI ✓',
  error: 'CI ✗',
  warning: 'CI …',
};

// Names one or two reviewers and counts larger groups to keep the footer short.
function awaitingText(reviewers: string[]) {
  if (reviewers.length > 2) return `awaiting ${reviewers.length} reviewers`;
  return `awaiting ${reviewers.map((username) => `@${username}`).join(', ')}`;
}

// "N approval(s)" or "N approval(s) · K more needed" or "K more needed". Returns undefined when nobody approved and nothing is required.
export function approvalCount(request: GitLabMergeRequest): Segment | undefined {
  const { approvers, approvalsRequired, approvalsLeft } = request;
  const given = approvers.length;
  if (approvalsRequired === 0 && given === 0) return undefined;
  const moreNeeded = approvalsLeft > 0;
  if (given === 0 && moreNeeded) {
    return { text: `${approvalsLeft} more needed`, compact: `+${approvalsLeft}`, tone: 'warning' };
  }
  const base = given === 1 ? '1 approval' : `${given} approvals`;
  const compactBase = `${given} ✓`;
  if (!moreNeeded) {
    return { text: `${given} approved`, compact: compactBase, tone: 'success' };
  }
  return {
    text: `${base} · ${approvalsLeft} more needed`,
    compact: `${compactBase} +${approvalsLeft}`,
    tone: 'warning',
  };
}

export type NeedsYouReason = 'CI failed' | 'changes requested' | 'conflicts';

// A Duo re-review in progress supersedes the earlier request: GitLab can keep reporting
// REQUESTED_CHANGES as the merge status until the new review finishes.
function changesRequested(request: GitLabMergeRequest): boolean {
  return (
    (request.awaitingReviewers?.length ?? 0) === 0 &&
    !request.approvalRequirementsSatisfied &&
    request.mergeStatus === 'REQUESTED_CHANGES' &&
    request.duoReviewState !== 'REVIEW_STARTED'
  );
}

// Why does this MR need immediate action? Returns undefined when it doesn't.
export function needsYouReason(request: GitLabMergeRequest): NeedsYouReason | undefined {
  if (request.state !== 'opened' || request.draft) return undefined;
  if (request.conflicts) return 'conflicts';
  if (changesRequested(request)) return 'changes requested';
  if (pipelineTone(request.pipeline) === 'error') return 'CI failed';
  return undefined;
}

// What is blocking this MR from merging? Returns the most actionable label.
export function waitingOn(request: GitLabMergeRequest): Segment | undefined {
  if (request.draft) return undefined;

  if (changesRequested(request))
    return { text: 'needs you: changes requested', tone: 'error', essential: true };

  if (request.conflicts) return undefined;

  const ciTone = pipelineTone(request.pipeline);
  if (ciTone === 'error') return { text: 'needs you: CI failed', tone: 'error', essential: true };

  if (!request.approved) {
    const unqualified = request.missingRules.find((r) => r.eligibleReviewers.length === 0);
    if (unqualified) {
      const label = unqualified.name.startsWith('/') ? 'needs a code owner' : 'needs an approver';
      return { text: label, tone: 'warning' };
    }
    if (request.awaitingReviewers.length) {
      return { text: awaitingText(request.awaitingReviewers), tone: 'muted' };
    }
    return { text: 'needs a reviewer', tone: 'muted' };
  }

  if (request.mergeTrainIndex !== null) {
    return { text: `merge train #${request.mergeTrainIndex + 1}`, tone: 'muted' };
  }

  if (request.autoMergeEnabled) {
    return {
      text: ciTone === 'warning' ? 'auto-merge set, CI running' : 'auto-merge set',
      tone: 'success',
    };
  }

  if (ciTone === 'warning') return { text: 'waiting on CI', tone: 'muted' };

  return { text: 'ready to merge', tone: 'success' };
}

function threadsText(request: ReviewRequest) {
  return `${request.unresolvedThreads}${request.threadsComplete ? '' : '+'} unresolved thread${request.unresolvedThreads === 1 && request.threadsComplete ? '' : 's'}`;
}

const link = (request: ReviewRequest): Segment => ({
  text: reference(request),
  tone: 'muted',
  url: request.url,
  essential: true,
});

function ci(request: ReviewRequest): Segment {
  const tone = pipelineTone(request.pipeline);
  if (!request.pipeline) return { text: `no ${traitsOf(request).ci}`, compact: 'no CI', tone };
  return {
    text: `CI ${request.pipeline.label}`,
    compact: COMPACT_CI[tone],
    tone,
    url: request.pipeline.url,
  };
}

type GroupKey =
  | 'needsYou'
  | 'needsReviewer'
  | 'readyToMerge'
  | 'draft'
  | 'autoMerge'
  | 'waitingOnCI'
  | 'waitingOnReviewer'
  | 'other';

export function groupOf(request: ReviewRequest): GroupKey {
  if (request.state !== 'opened') return 'other';
  if (request.forge !== 'gitlab') {
    if (pipelineTone(request.pipeline) === 'error' || request.conflicts) return 'needsYou';
    if (request.approved && request.awaitingReviewers.length === 0) return 'readyToMerge';
    if (request.awaitingReviewers.length) return 'waitingOnReviewer';
    return 'other';
  }
  if (request.draft) return 'draft';
  if (request.conflicts) return 'needsYou';
  const w = waitingOn(request);
  if (!w) return 'other';
  if (w.text.startsWith('needs you')) return 'needsYou';
  if (
    w.text === 'needs a reviewer' ||
    w.text === 'needs a code owner' ||
    w.text === 'needs an approver'
  )
    return 'needsReviewer';
  if (w.text === 'ready to merge') return 'readyToMerge';
  if (w.text === 'auto-merge set' || w.text === 'auto-merge set, CI running') return 'autoMerge';
  if (request.mergeTrainIndex !== null) return 'autoMerge';
  if (w.text === 'waiting on CI') return 'waitingOnCI';
  if (w.text.startsWith('awaiting')) return 'waitingOnReviewer';
  return 'other';
}

// Counts the PRs/MRs in each state, for a session with several targets.
// Clicking a segment opens the status dialog filtered to just those MRs.
function targetsSummary(requests: ReviewRequest[]): Segment[] {
  const nouns = new Set(requests.map((request) => traitsOf(request).noun));
  const noun = nouns.size === 1 ? [...nouns][0] : 'PR/MR';
  const count =
    requests.length === 1
      ? `1 ${noun}`
      : `${requests.length} ${noun === 'PR/MR' ? 'PRs/MRs' : `${noun}s`}`;
  const open = requests.filter((request) => request.state === 'opened');

  const groups = new Map<GroupKey, ReviewRequest[]>();
  for (const r of open) {
    const key = groupOf(r);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const urls = (key: GroupKey) => (groups.get(key) ?? []).map((r) => r.url);
  const seg = (
    key: GroupKey,
    text: string,
    tone: Tone,
    essential?: boolean,
  ): Segment | undefined => {
    const n = groups.get(key)?.length ?? 0;
    if (!n) return undefined;
    return { text: `${n} ${text}`, tone, essential, filterUrls: urls(key) };
  };

  const segments: Segment[] = [{ text: count, tone: 'muted', essential: true }];

  const reviewing = open.filter((r) => automatedReview(r)?.state === 'running').length;
  if (reviewing)
    segments.push({
      text: `🤖 ${reviewing} reviewing`,
      compact: `🤖 ${reviewing}`,
      tone: 'warning',
      essential: true,
      filterUrls: open.filter((r) => automatedReview(r)?.state === 'running').map((r) => r.url),
    });

  const order: [GroupKey, string, Tone, boolean?][] = [
    ['needsYou', 'needs you', 'error', true],
    ['needsReviewer', 'needs a reviewer', 'warning', true],
    ['readyToMerge', 'ready to merge', 'success'],
    ['draft', 'draft', 'muted'],
    ['autoMerge', 'auto-merge set', 'success'],
    ['waitingOnCI', 'waiting on CI', 'muted'],
    ['waitingOnReviewer', 'waiting on reviewer', 'muted'],
  ];
  for (const [key, text, tone, essential] of order) {
    const s = seg(key, text, tone, essential);
    if (s) segments.push(s);
  }

  const merged = requests.filter((r) => r.state === 'merged').length;
  if (merged) segments.push({ text: `${merged} merged`, tone: 'success' });
  const closed = requests.length - open.length - merged;
  if (closed) segments.push({ text: `${closed} closed`, tone: 'muted' });
  return segments;
}

export function footerSegments(snapshot: Snapshot): Segment[] {
  const { lookup, error } = snapshot;
  const stale: Segment[] = error ? [{ text: 'stale', tone: 'warning', essential: true }] : [];
  // Without a PR/MR to show, only explicit PR/MR targets warn. A failed
  // branch lookup, such as in a new session, may concern no PR/MR at all;
  // /forge-status still explains it.
  if (!lookup || lookup.kind === 'none' || lookup.requests.length === 0) {
    return snapshot.targeted && (error || lookup?.explicitTarget)
      ? [{ text: 'PR/MR status unavailable', tone: 'warning' }]
      : [];
  }
  if (lookup.failed?.length) {
    stale.unshift({
      text: `${lookup.failed.length} unavailable`,
      tone: 'warning',
      essential: true,
    });
  }

  const requests = lookup.requests;
  if (lookup.explicitTarget && requests.length > 1) return [...targetsSummary(requests), ...stale];
  if (requests.length > 1) {
    const noun = traitsOf(requests[0]).noun;
    return [
      ...requests.map(link),
      {
        text: `${plural(requests.length, `open ${noun}`)}, run /${noun.toLowerCase()}-status`,
        tone: 'warning',
      },
      ...stale,
    ];
  }

  const [request] = requests;
  if (request.state !== 'opened') {
    return [
      link(request),
      {
        text: request.state,
        tone: request.state === 'merged' ? 'success' : 'muted',
        essential: true,
      },
      ...stale,
    ];
  }
  const segments = [link(request), ci(request)];
  if (request.unresolvedThreads > 0 || !request.threadsComplete) {
    const text = threadsText(request);
    segments.push({ text, compact: text.replace('unresolved ', ''), tone: 'warning' });
  }
  if (automatedReview(request)?.state === 'running') {
    segments.push({ text: '🤖 reviewing', compact: '🤖', tone: 'warning', essential: true });
  }
  segments.push(...traitsOf(request).indicators(request));
  if (request.conflicts) segments.push({ text: 'conflicts', tone: 'error', essential: true });
  if (!request.conflictsKnown) segments.push({ text: 'mergeability unknown', tone: 'muted' });
  if (request.forge === 'gitlab') {
    const count = approvalCount(request);
    if (count) segments.push(count);
    const next = waitingOn(request);
    if (next) segments.push(next);
  } else {
    if (request.awaitingReviewers.length)
      segments.push({ text: awaitingText(request.awaitingReviewers), tone: 'muted' });
    else if (request.approved) segments.push({ text: 'approved', tone: 'success' });
  }
  return [...segments, ...stale];
}

export const segmentsWidth = (segments: Segment[]) =>
  Bun.stringWidth(segments.map((segment) => segment.text).join(' · '));

export function responsiveFooterSegments(snapshot: Snapshot, width: number): Segment[] {
  const full = footerSegments(snapshot);
  if (segmentsWidth(full) <= width) return full;

  const compact = full.map(
    (segment): Segment => ({
      ...segment,
      text: segment.compact ?? segment.text,
    }),
  );
  if (segmentsWidth(compact) <= width) return compact;

  const minimal = compact.filter((segment) => segment.essential);
  if (segmentsWidth(minimal) <= width) return minimal;

  // Keep the PR/MR link first, then add only complete indicators that fit.
  if (minimal[0] && segmentsWidth([minimal[0]]) > width) return [];
  const fitted: Segment[] = [];
  for (const segment of minimal) {
    if (segmentsWidth([...fitted, segment]) <= width) fitted.push(segment);
  }
  return fitted;
}

const time = (value: number) => new Date(value).toLocaleTimeString();

function describe(request: ReviewRequest, head: string): string[] {
  const traits = traitsOf(request);
  const lines = [
    `${reference(request)} ${request.title}${request.state === 'opened' ? '' : ` (${request.state})`}`,
    `Target: ${request.targetProject} → ${request.targetBranch}`,
    `${capitalize(traits.ci)}: ${request.pipeline ? request.pipeline.label : 'none'}${request.pipeline?.url ? ` (${request.pipeline.url})` : ''}`,
    `Unresolved threads: ${request.unresolvedThreads}${request.threadsComplete ? '' : '+'}`,
    `Draft: ${yesNo(request.draft)} · Conflicts: ${request.conflictsKnown ? yesNo(request.conflicts) : 'unknown'}`,
    ...traits.details(request),
  ];
  const review = automatedReview(request);
  if (review) lines.push(`${review.name} review: ${review.label}`);
  if (request.awaitingReviewers.length) {
    lines.push(
      `Awaiting review: ${request.awaitingReviewers.map((username) => `@${username}`).join(', ')}`,
    );
  }
  if (!request.reviewersComplete) lines.push('Reviewer list is partial');
  if (head && request.headSha && head !== request.headSha) {
    lines.push(`Local HEAD differs from the ${traits.noun} head commit (unpushed or not fetched)`);
  }
  lines.push(request.url);
  return lines;
}

export function detailsMessage(snapshot: Snapshot): string {
  const { lookup, error, fetchedAt } = snapshot;
  const lines: string[] = [];

  if (!lookup) {
    lines.push(error ? 'Could not look up the PR/MR.' : 'No data yet.');
  } else if (lookup.kind === 'none') {
    lines.push(`No PR/MR lookup: ${lookup.reason}.`);
  } else {
    const { repository, sessionTarget, requests } = lookup;
    if (repository) {
      const branch =
        repository.branch === repository.sourceBranch
          ? repository.branch
          : `${repository.branch} (pushes to ${repository.sourceBranch})`;
      lines.push(`Branch: ${branch} in ${repository.source.path}`);
      if (requests.length === 0) lines.push('', 'No open PR/MR for this branch.');
    } else if (sessionTarget) {
      lines.push(`Session target: ${sessionTarget}`);
    }
    for (const { url, reason } of lookup.failed ?? [])
      lines.push(`Unavailable: ${url} (${reason})`);
    for (const request of requests) lines.push('', ...describe(request, repository?.head ?? ''));
  }

  if (error) lines.push('', `Last refresh failed at ${time(error.at)}: ${error.message}`);
  if (fetchedAt !== undefined) lines.push('', `Last fetched: ${time(fetchedAt)}`);
  return lines.join('\n');
}
