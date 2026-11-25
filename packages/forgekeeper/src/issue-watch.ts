import type { IssueSnapshot, ReviewRef, ReviewRequest } from './forge';
import { parseUrl, reference, traits } from './forges';
import { relatedIssueRef, sameRef, targetRequest, type Target } from './target';

const RECORD_RETENTION = 30 * 24 * 60 * 60_000;

// shortcut: the status ladder and label prefixes follow GitLab work item statuses and the DX
// team's labels, make them options when another team needs different ones.
const STATUS_LADDER = ['new', 'ready for development', 'in dev', 'in review', 'complete'];
const REQUIRED_LABELS = [
  { name: 'group', prefixes: ['group::'] },
  { name: 'type', prefixes: ['maintenance::', 'bug::', 'feature::'] },
];

export interface IssueProblem {
  // Stable per problem, so a problem is announced once until it is fixed.
  id: string;
  text: string;
}

export interface IssueRecord {
  problems: string[];
  at: number;
}

// What an open issue's fields get wrong, given the PRs/MRs that work on it.
export function issueProblems(
  issue: IssueSnapshot,
  requests: readonly ReviewRequest[],
): IssueProblem[] {
  if (!issue.open) return [];
  const problems: IssueProblem[] = [];

  const open = requests.filter((request) => request.state === 'opened');
  if (open.length === 0 && requests.some((request) => request.state === 'merged')) {
    problems.push({
      id: 'merged',
      text: 'every linked MR is merged but the issue is still open. Close it and set the status to "Complete", or keep it open on purpose',
    });
  } else if (open.length > 0) {
    const expected = open.some((request) => !request.draft) ? 'In review' : 'In dev';
    const current = issue.status?.toLowerCase();
    const behind =
      current === undefined ||
      (STATUS_LADDER.includes(current) &&
        STATUS_LADDER.indexOf(current) < STATUS_LADDER.indexOf(expected.toLowerCase()));
    if (behind) {
      problems.push({
        id: `status:${expected}`,
        text: `the status is ${issue.status ? `"${issue.status}"` : 'not set'}, expected "${expected}"`,
      });
    }
  }

  if (issue.assignees.length === 0) problems.push({ id: 'unassigned', text: 'no assignee' });
  for (const { name, prefixes } of REQUIRED_LABELS) {
    if (!issue.labels.some((label) => prefixes.some((prefix) => label.startsWith(prefix))))
      problems.push({ id: `label:${name}`, text: `no ${name} label (${prefixes.join(', ')})` });
  }
  if (!issue.milestone) problems.push({ id: 'milestone', text: 'no milestone' });
  return problems;
}

export interface IssueWatcherOptions {
  targets: (sessionID: string) => Promise<Target[]>;
  fetch: (ref: ReviewRef) => Promise<IssueSnapshot | undefined>;
  record: (key: string) => Promise<IssueRecord | undefined>;
  persist: (key: string, record: IssueRecord | undefined) => void;
  send: (
    sessionID: string,
    ref: ReviewRef,
    requests: ReviewRequest[],
    problems: IssueProblem[],
  ) => Promise<void>;
  onFetchError?: (error: unknown) => void;
  onSendError?: (error: unknown) => void;
  now?: () => number;
}

// shortcut: GitLab's issue URL shape, because only GitLab reads issues. Extend when GitHub does.
const issueUrl = (ref: ReviewRef) => `https://${ref.host}/${ref.project}/-/issues/${ref.iid}`;
const issueName = (ref: ReviewRef) => traits(ref.forge).issueReference(ref.iid);

export function issueMessage(
  ref: ReviewRef,
  requests: readonly ReviewRequest[],
  problems: readonly IssueProblem[],
): string {
  const mrs = requests.map(reference).join(', ');
  return `Issue ${issueName(ref)} (${issueUrl(ref)}) looks outdated after ${mrs}: ${problems.map((p) => p.text).join('; ')}. Tell the user what you would change and wait for approval before editing the issue.`;
}

export function issueToast(ref: ReviewRef) {
  return { title: `Issue ${issueName(ref)} may be outdated`, message: 'Sent to the agent.' };
}

export function createIssueWatcher(options: IssueWatcherOptions) {
  const now = options.now ?? Date.now;
  const inflight = new Set<string>();
  // The PR/MR states each issue was last checked against, so a poll that
  // changed nothing doesn't read the issue again.
  const seen = new Map<string, string>();

  async function checkIssue(
    key: string,
    sessionID: string,
    ref: ReviewRef,
    requests: ReviewRequest[],
  ) {
    const signature = requests
      .map((request) => `${request.url} ${request.state} ${request.draft}`)
      .sort()
      .join('\n');
    if (inflight.has(key) || seen.get(key) === signature) return;
    inflight.add(key);
    try {
      let issue: IssueSnapshot | undefined;
      try {
        issue = await options.fetch(ref);
      } catch (error) {
        options.onFetchError?.(error);
        return;
      }
      seen.set(key, signature);
      if (!issue) return;

      const problems = issueProblems(issue, requests);
      const ids = problems.map((problem) => problem.id);
      const stored = await options.record(key);
      const announced = new Set(stored?.problems);
      const fresh = problems.some((problem) => !announced.has(problem.id));

      if (fresh) {
        try {
          await options.send(sessionID, ref, requests, problems);
        } catch (error) {
          seen.delete(key);
          options.onSendError?.(error);
          return;
        }
        options.persist(key, { problems: ids, at: now() });
      } else if (stored && ids.length !== stored.problems.length) {
        options.persist(key, ids.length ? { problems: ids, at: stored.at } : undefined);
      }
    } finally {
      inflight.delete(key);
    }
  }

  return {
    // `requests` are the session's PR/MR targets. Their related issues are
    // checked, and the session hears about problems it wasn't told about.
    async check(sessionID: string, requests: ReviewRequest[]): Promise<void> {
      const groups = new Map<string, { ref: ReviewRef; requests: ReviewRequest[] }>();
      for (const target of await options.targets(sessionID)) {
        const ref = relatedIssueRef(target);
        const own = targetRequest(target);
        if (!ref || !own) continue;
        const matching = requests.filter((request) => {
          const parsed = parseUrl(request.url);
          return parsed !== undefined && sameRef(parsed, own);
        });
        if (matching.length === 0) continue;
        const key = `${sessionID} ${ref.host} ${ref.project.toLowerCase()} ${ref.iid}`;
        const group = groups.get(key) ?? { ref, requests: [] };
        group.requests.push(...matching);
        groups.set(key, group);
      }
      for (const [key, group] of groups) await checkIssue(key, sessionID, group.ref, group.requests);
    },

    isExpired(record: IssueRecord, at: number) {
      return at - record.at > RECORD_RETENTION;
    },
  };
}

export type IssueWatcher = ReturnType<typeof createIssueWatcher>;
