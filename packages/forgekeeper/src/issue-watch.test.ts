import { describe, expect, test } from 'bun:test';
import type { IssueSnapshot, ReviewRequest } from './forge';
import {
  createIssueWatcher,
  issueMessage,
  issueProblems,
  type IssueProblem,
  type IssueRecord,
} from './issue-watch';
import type { Target } from './target';

const mr = (state: string, draft = false): ReviewRequest =>
  ({
    forge: 'gitlab',
    iid: '45',
    url: 'https://gitlab.com/g/p/-/merge_requests/45',
    state,
    draft,
  }) as ReviewRequest;

const complete: IssueSnapshot = {
  open: true,
  status: 'In review',
  assignees: ['me'],
  labels: ['group::development health', 'feature::addition'],
  milestone: '18.10',
};

const ids = (issue: IssueSnapshot, ...requests: ReviewRequest[]) =>
  issueProblems(issue, requests).map((problem) => problem.id);

describe('issueProblems', () => {
  test('finds nothing wrong with an up to date issue', () => {
    expect(ids(complete, mr('opened'))).toEqual([]);
  });

  test('expects In dev for a draft MR and In review for a ready one', () => {
    const ready: IssueSnapshot = { ...complete, status: 'Ready for development' };
    expect(ids(ready, mr('opened', true))).toEqual(['status:In dev']);
    expect(ids(ready, mr('opened'))).toEqual(['status:In review']);
    expect(ids({ ...complete, status: 'In dev' }, mr('opened', true))).toEqual([]);
  });

  test('flags a missing status, and leaves statuses off the ladder alone', () => {
    expect(ids({ ...complete, status: undefined }, mr('opened'))).toEqual(['status:In review']);
    expect(ids({ ...complete, status: 'Blocked' }, mr('opened'))).toEqual([]);
  });

  test('flags an open issue whose MRs are all merged', () => {
    expect(ids(complete, mr('merged'))).toEqual(['merged']);
    expect(ids({ ...complete, open: false }, mr('merged'))).toEqual([]);
  });

  test('flags a missing assignee, group label, type label, and milestone', () => {
    const bare: IssueSnapshot = { open: true, status: 'In review', assignees: [], labels: [] };
    expect(ids(bare, mr('opened'))).toEqual([
      'unassigned',
      'label:group',
      'label:type',
      'milestone',
    ]);
  });
});

describe('createIssueWatcher', () => {
  const target: Target = {
    url: 'https://gitlab.com/g/p/-/merge_requests/45',
    issueUrl: 'https://gitlab.com/g/p/-/issues/12',
  };

  function setup(issue: () => IssueSnapshot | undefined) {
    const records = new Map<string, IssueRecord>();
    const sent: IssueProblem[][] = [];
    let fetches = 0;
    const watcher = createIssueWatcher({
      targets: async () => [target],
      fetch: async () => {
        fetches++;
        return issue();
      },
      record: async (key) => records.get(key),
      persist: (key, record) =>
        record ? void records.set(key, record) : void records.delete(key),
      send: async (_session, _ref, _requests, problems) => void sent.push(problems),
    });
    return { watcher, sent, records, fetches: () => fetches };
  }

  const stale: IssueSnapshot = { ...complete, status: 'Ready for development' };

  test('tells the session once, and again only for a new problem', async () => {
    let issue: IssueSnapshot = stale;
    const { watcher, sent, records } = setup(() => issue);

    await watcher.check('s1', [mr('opened', true)]);
    expect(sent.map((problems) => problems.map((p) => p.id))).toEqual([['status:In dev']]);

    await watcher.check('s1', [mr('opened', true)]);
    expect(sent).toHaveLength(1);

    issue = { ...stale, assignees: [] };
    await watcher.check('s1', [mr('opened')]);
    expect(sent.map((problems) => problems.map((p) => p.id))).toEqual([
      ['status:In dev'],
      ['status:In review', 'unassigned'],
    ]);
    expect([...records.values()][0].problems).toEqual(['status:In review', 'unassigned']);
  });

  test('reads the issue again only when the MR changed', async () => {
    const { watcher, fetches } = setup(() => stale);
    await watcher.check('s1', [mr('opened', true)]);
    await watcher.check('s1', [mr('opened', true)]);
    expect(fetches()).toBe(1);
    await watcher.check('s1', [mr('merged')]);
    expect(fetches()).toBe(2);
  });

  test('forgets fixed problems, so they are announced again if they return', async () => {
    let issue: IssueSnapshot = stale;
    const { watcher, sent, records } = setup(() => issue);
    await watcher.check('s1', [mr('opened', true)]);
    issue = complete;
    await watcher.check('s1', [mr('opened')]);
    expect(records.size).toBe(0);
    issue = stale;
    await watcher.check('s1', [mr('merged')]);
    expect(sent).toHaveLength(2);
  });

  test('ignores an MR without a related issue', async () => {
    const { watcher, sent, fetches } = setup(() => stale);
    const other = { ...mr('opened'), url: 'https://gitlab.com/g/p/-/merge_requests/99' };
    await watcher.check('s1', [other as ReviewRequest]);
    expect(fetches()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('issueMessage', () => {
  test('names the issue, the MRs, and the problems, and asks for approval', () => {
    const message = issueMessage(
      { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', iid: '12' },
      [mr('opened')],
      [{ id: 'unassigned', text: 'no assignee' }],
    );
    expect(message).toContain('Issue #12 (https://gitlab.com/g/p/-/issues/12)');
    expect(message).toContain('!45: no assignee');
    expect(message).toContain('wait for approval');
  });
});
