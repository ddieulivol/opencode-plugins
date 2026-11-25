import { describe, expect, test } from 'bun:test';
import {
  detailsMessage,
  footerSegments,
  needsYouReason,
  responsiveFooterSegments,
  segmentsWidth,
} from './format';
import type { Repository } from './git';
import type { GitLabMergeRequest } from './forge';
import type { Snapshot } from './store';

const repository: Repository = {
  head: 'local',
  branch: 'feature',
  sourceBranch: 'feature',
  source: { host: 'gitlab.com', path: 'group/project' },
  targets: [],
};

const mr = (overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest => ({
  forge: 'gitlab',
  conflictsKnown: true,
  awaitingReviewers: [],
  reviewersComplete: true,
  iid: '4281',
  title: 'Add things',
  url: 'https://gitlab.com/group/project/-/merge_requests/4281',
  state: 'opened',
  draft: false,
  conflicts: false,
  approved: false,
  hasApprovals: false,
  approvers: [],
  approvalRequirementsSatisfied: false,
  approvalsRequired: 1,
  approvalsLeft: 1,
  missingRules: [],
  autoMergeEnabled: false,
  mergeTrainIndex: null,
  targetProject: 'group/project',
  targetBranch: 'main',
  headSha: 'local',
  pipeline: { status: 'FAILED', label: 'failed' },
  unresolvedThreads: 2,
  threadsComplete: true,
  ...overrides,
});

const snapshot = (requests: GitLabMergeRequest[], extra: Partial<Snapshot> = {}): Snapshot => ({
  lookup: { kind: 'found', repository, requests },
  fetchedAt: 0,
  loading: false,
  ...extra,
});

const text = (value: Snapshot) =>
  footerSegments(value)
    .map((segment) => segment.text)
    .join(' · ');

describe('footerSegments', () => {
  test('shows an active Duo review', () => {
    expect(text(snapshot([mr({ duoReviewState: 'REVIEW_STARTED' })]))).toBe(
      '!4281 · CI failed · 2 unresolved threads · 🤖 reviewing · 1 more needed · needs you: CI failed',
    );
  });

  test.each(['REVIEWED', 'UNREVIEWED', 'APPROVED', undefined])(
    'omits inactive Duo reviews: %s',
    (duoReviewState) => {
      expect(text(snapshot([mr({ duoReviewState })]))).not.toContain('🤖');
    },
  );

  test('omits the Duo indicator on merged MRs', () => {
    expect(text(snapshot([mr({ state: 'merged', duoReviewState: 'REVIEW_STARTED' })]))).toBe(
      '!4281 · merged',
    );
  });
  test('shows the MR, pipeline, and threads', () => {
    expect(text(snapshot([mr()]))).toBe(
      '!4281 · CI failed · 2 unresolved threads · 1 more needed · needs you: CI failed',
    );
  });

  test('adds conflicts and omits resolved threads', () => {
    const value = snapshot([
      mr({ unresolvedThreads: 0, conflicts: true, approved: true, pipeline: undefined }),
    ]);
    expect(text(value)).toBe('!4281 · no pipeline · conflicts · 1 more needed');
  });

  test('does not ask for changes while Duo is re-reviewing', () => {
    const changes = mr({ mergeStatus: 'REQUESTED_CHANGES', pipeline: undefined });
    expect(needsYouReason(changes)).toBe('changes requested');
    expect(text(snapshot([changes]))).toContain('needs you: changes requested');

    const reviewing = { ...changes, duoReviewState: 'REVIEW_STARTED' };
    expect(needsYouReason(reviewing)).toBeUndefined();
    expect(text(snapshot([reviewing]))).not.toContain('changes requested');
  });

  test('shows approval count and waiting-on label', () => {
    const base = { unresolvedThreads: 0, pipeline: { status: 'SUCCESS', label: 'passed' } };
    expect(
      text(
        snapshot([
          mr({
            ...base,
            approved: true,
            approvers: ['alice'],
            approvalsLeft: 0,
            approvalRequirementsSatisfied: true,
          }),
        ]),
      ),
    ).toBe('!4281 · CI passed · 1 approved · ready to merge');
    expect(
      text(
        snapshot([
          mr({
            ...base,
            approved: true,
            approvers: ['alice'],
            approvalsLeft: 0,
            approvalRequirementsSatisfied: true,
            autoMergeEnabled: true,
          }),
        ]),
      ),
    ).toBe('!4281 · CI passed · 1 approved · auto-merge set');
    expect(
      text(
        snapshot([
          mr({
            ...base,
            approved: true,
            approvers: ['alice'],
            approvalsLeft: 0,
            approvalRequirementsSatisfied: true,
            pipeline: { status: 'RUNNING', label: 'running' },
          }),
        ]),
      ),
    ).toBe('!4281 · CI running · 1 approved · waiting on CI');
    expect(
      text(
        snapshot([
          mr({
            ...base,
            approved: false,
            approvers: ['alice'],
            approvalsLeft: 1,
            approvalsRequired: 2,
            approvalRequirementsSatisfied: false,
            awaitingReviewers: ['david'],
          }),
        ]),
      ),
    ).toBe('!4281 · CI passed · 1 approval · 1 more needed · awaiting @david');
    expect(
      text(
        snapshot([
          mr({ ...base, approved: false, approvalsLeft: 1, approvalRequirementsSatisfied: false }),
        ]),
      ),
    ).toBe('!4281 · CI passed · 1 more needed · needs a reviewer');
    expect(
      text(
        snapshot([
          mr({
            ...base,
            approved: true,
            approvers: [],
            approvalsLeft: 0,
            approvalsRequired: 0,
            approvalRequirementsSatisfied: true,
          }),
        ]),
      ),
    ).toBe('!4281 · CI passed · ready to merge');
  });

  test('marks incomplete thread counts', () => {
    expect(text(snapshot([mr({ unresolvedThreads: 1, threadsComplete: false })]))).toContain(
      '1+ unresolved threads',
    );
  });

  test('is empty without an MR or repository', () => {
    expect(footerSegments(snapshot([]))).toEqual([]);
    expect(
      footerSegments({ lookup: { kind: 'none', reason: 'Detached HEAD' }, loading: false }),
    ).toEqual([]);
    expect(footerSegments({ loading: true })).toEqual([]);
  });

  test('warns about missing status only for explicit targets', () => {
    const error = { kind: 'auth' as const, message: 'GitLab authentication failed', at: 0 };
    expect(footerSegments({ loading: false, error })).toEqual([]);
    expect(
      footerSegments({ lookup: { kind: 'none', reason: 'Detached HEAD' }, loading: false, error }),
    ).toEqual([]);
    expect(text({ loading: false, error, targeted: true })).toBe('PR/MR status unavailable');
    expect(text({ loading: true, error, targeted: true })).toBe('PR/MR status unavailable');
    const unresolved = { kind: 'none' as const, reason: 'Not found', explicitTarget: true };
    expect(text({ lookup: unresolved, loading: false, targeted: true })).toBe(
      'PR/MR status unavailable',
    );
    expect(text({ lookup: unresolved, loading: true, targeted: true })).toBe(
      'PR/MR status unavailable',
    );
    expect(text(snapshot([mr()], { error }))).toBe(
      '!4281 · CI failed · 2 unresolved threads · 1 more needed · needs you: CI failed · stale',
    );
  });

  test('keeps an explicit target quiet until its first lookup finishes', () => {
    for (const loading of [false, true]) {
      expect(footerSegments({ loading, targeted: true })).toEqual([]);
      expect(footerSegments(snapshot([], { loading, targeted: true }))).toEqual([]);
      expect(
        footerSegments({
          lookup: { kind: 'none', reason: 'Detached HEAD' },
          loading,
          targeted: true,
        }),
      ).toEqual([]);
    }
  });

  test('does not pick one of several MRs', () => {
    expect(text(snapshot([mr(), mr({ iid: '9' })]))).toBe(
      '!4281 · !9 · 2 open MRs, run /mr-status',
    );
  });

  test('summarizes several session targets', () => {
    const targets = (
      requests: GitLabMergeRequest[],
      failed?: { url: string; reason: string }[],
    ): Snapshot => ({
      lookup: {
        kind: 'found',
        explicitTarget: true,
        sessionTarget: '4 PRs/MRs set with set_session_target',
        requests,
        ...(failed ? { failed } : {}),
      },
      loading: false,
    });
    const requests = [
      mr({ iid: '1', duoReviewState: 'REVIEW_STARTED' }),
      mr({
        iid: '2',
        duoReviewState: 'REVIEW_STARTED',
        conflicts: true,
        pipeline: { status: 'SUCCESS', label: 'passed' },
      }),
      mr({
        iid: '3',
        approved: true,
        approvers: ['alice'],
        approvalsLeft: 0,
        approvalRequirementsSatisfied: true,
        pipeline: undefined,
      }),
      mr({ iid: '4', state: 'merged' }),
      mr({ iid: '5', state: 'closed' }),
    ];
    expect(text(targets(requests))).toBe(
      '5 MRs · 🤖 2 reviewing · 2 needs you · 1 ready to merge · 1 merged · 1 closed',
    );
    expect(footerSegments(targets(requests)).every((segment) => !segment.url)).toBe(true);

    const failed = [
      {
        url: 'https://gitlab.com/group/project/-/merge_requests/6',
        reason: 'GitLab request failed',
      },
    ];
    const partial = targets(requests.slice(2, 4), failed);
    expect(text(partial)).toBe('2 MRs · 1 ready to merge · 1 merged · 1 unavailable');
    expect(detailsMessage(partial)).toContain(
      'Unavailable: https://gitlab.com/group/project/-/merge_requests/6 (GitLab request failed)',
    );
    // One remaining target shows its full status, and still reports the others.
    expect(text(targets([mr()], failed))).toBe(
      '!4281 · CI failed · 2 unresolved threads · 1 more needed · needs you: CI failed · 1 unavailable',
    );
  });

  test('shows only the state of a merged or closed session target', () => {
    const merged = {
      lookup: {
        kind: 'found' as const,
        sessionTarget: '!4281 (from the session title)',
        requests: [mr({ state: 'merged' })],
      },
      loading: false,
    };
    expect(text(merged)).toBe('!4281 · merged');
    expect(detailsMessage(merged)).toContain('Session target: !4281');
  });

  test('links the MR and pipeline', () => {
    const [iid, pipeline, threads] = footerSegments(
      snapshot([
        mr({
          pipeline: {
            status: 'SUCCESS',
            label: 'passed',
            url: 'https://gitlab.com/p/-/pipelines/1',
          },
        }),
      ]),
    );
    expect(iid.url).toBe('https://gitlab.com/group/project/-/merge_requests/4281');
    expect(pipeline.url).toBe('https://gitlab.com/p/-/pipelines/1');
    expect(threads.url).toBeUndefined();
  });
});

describe('detailsMessage', () => {
  test("includes Duo's review state when available", () => {
    expect(detailsMessage(snapshot([mr({ duoReviewState: 'REVIEW_STARTED' })]))).toContain(
      'Duo review: review started',
    );
    expect(detailsMessage(snapshot([mr({ duoReviewState: 'REVIEWED' })]))).toContain(
      'Duo review: reviewed',
    );
    expect(detailsMessage(snapshot([mr()]))).not.toContain('Duo review:');
  });
  test('shows approval details', () => {
    const withApprover = detailsMessage(
      snapshot([
        mr({ approvers: ['alice'], approvalRequirementsSatisfied: true, approvalsLeft: 0 }),
      ]),
    );
    expect(withApprover).toContain('Approved by: @alice');
    expect(withApprover).not.toContain('Still needed:');
    const withMissing = detailsMessage(
      snapshot([
        mr({
          missingRules: [
            { name: '/AGENTS.md', required: 1, eligibleReviewers: ['tkuah'], eligible: ['tkuah'] },
          ],
        }),
      ]),
    );
    expect(withMissing).toContain('Still needed: /AGENTS.md (1, @tkuah can approve)');
    const noApprovers = detailsMessage(snapshot([mr()]));
    expect(noApprovers).not.toContain('Approved by:');
    expect(noApprovers).not.toContain('Still needed:');
  });

  test('lists pending reviewers', () => {
    expect(detailsMessage(snapshot([mr({ awaitingReviewers: ['david', 'erin'] })]))).toContain(
      'Awaiting review: @david, @erin',
    );
    expect(detailsMessage(snapshot([mr()]))).not.toContain('Awaiting review:');
  });

  test('shows auto-merge when set', () => {
    expect(detailsMessage(snapshot([mr({ autoMergeEnabled: true })]))).toContain('Auto-merge: set');
    expect(detailsMessage(snapshot([mr()]))).not.toContain('Auto-merge:');
  });

  test('includes the URL and head mismatch', () => {
    const message = detailsMessage(snapshot([mr({ headSha: 'remote' })]));
    expect(message).toContain('https://gitlab.com/group/project/-/merge_requests/4281');
    expect(message).toContain('Local HEAD differs');
  });

  test('explains why no lookup happened', () => {
    expect(
      detailsMessage({ lookup: { kind: 'none', reason: 'Detached HEAD' }, loading: false }),
    ).toContain('Detached HEAD');
  });
});

describe('responsiveFooterSegments', () => {
  const value = snapshot([
    mr({
      iid: '259389',
      duoReviewState: 'REVIEW_STARTED',
      pipeline: { status: 'SUCCESS', label: 'passed', url: 'https://gitlab.com/p/-/pipelines/1' },
    }),
  ]);
  const responsiveText = (width: number) =>
    responsiveFooterSegments(value, width)
      .map((segment) => segment.text)
      .join(' · ');

  test('selects full, compact, and minimal formats', () => {
    expect(responsiveText(100)).toBe(
      '!259389 · CI passed · 2 unresolved threads · 🤖 reviewing · 1 more needed · needs a reviewer',
    );
    expect(responsiveText(60)).toBe('!259389 · CI ✓ · 2 threads · 🤖 · +1 · needs a reviewer');
    expect(responsiveText(20)).toBe('!259389 · 🤖');
    expect(responsiveText(7)).toBe('!259389');
    expect(responsiveText(2)).toBe('');
    expect(responsiveText(0)).toBe('');
  });

  test('measures emoji in terminal cells', () => {
    expect(segmentsWidth([{ text: '🤖', tone: 'warning' }])).toBe(2);
    expect(responsiveText(12)).toBe('!259389 · 🤖');
    expect(responsiveText(11)).toBe('!259389');
  });

  test('preserves links and tones in compact mode', () => {
    const segments = responsiveFooterSegments(value, 60);
    expect(segments[0].url).toBe(mr().url);
    expect(segments[1]).toMatchObject({
      text: 'CI ✓',
      tone: 'success',
      url: 'https://gitlab.com/p/-/pipelines/1',
    });
    expect(segments[3]).toMatchObject({ text: '🤖', tone: 'warning' });
  });

  test('keeps conflict and stale warnings in minimal mode', () => {
    const sample = snapshot([mr({ conflicts: true })], {
      error: { kind: 'request', message: 'timeout', at: 0 },
    });
    expect(
      responsiveFooterSegments(sample, 28)
        .map((segment) => segment.text)
        .join(' · '),
    ).toBe('!4281 · conflicts · stale');
  });

  test('never exceeds the allocated width', () => {
    const samples = [
      value,
      snapshot([mr({ conflicts: true, approved: true })]),
      snapshot([mr({ awaitingReviewers: ['david', 'erin'] })]),
      snapshot([mr({ threadsComplete: false })]),
      snapshot([mr(), mr({ iid: '9' })]),
    ];
    for (const sample of samples) {
      for (let width = 0; width < 100; width++) {
        expect(segmentsWidth(responsiveFooterSegments(sample, width))).toBeLessThanOrEqual(width);
      }
    }
  });

  test('restores the full format when space increases', () => {
    responsiveFooterSegments(value, 12);
    expect(responsiveFooterSegments(value, 100)).toEqual(footerSegments(value));
  });
});
