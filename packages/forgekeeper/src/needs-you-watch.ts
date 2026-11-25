import type { GitLabMergeRequest, ReviewRequest } from './forge';
import { needsYouReason, type NeedsYouReason } from './format';
import { reference } from './forges';

const RECORD_RETENTION = 30 * 24 * 60 * 60_000;

export interface NeedsYouRecord {
  reason: NeedsYouReason;
  headSha: string;
  at: number;
}

export interface NeedsYouWatcherOptions {
  record: (key: string) => Promise<NeedsYouRecord | undefined>;
  persist: (key: string, record: NeedsYouRecord | undefined) => void;
  current: (sessionID: string, request: ReviewRequest) => boolean;
  send: (sessionID: string, request: GitLabMergeRequest, reason: NeedsYouReason) => Promise<void>;
  onSendError?: (error: unknown) => void;
  now?: () => number;
}

export function needsYouKey(sessionID: string, request: ReviewRequest) {
  return `${sessionID} ${request.url}`;
}

export function needsYouMessage(request: GitLabMergeRequest, reason: NeedsYouReason): string {
  const ref = reference(request);
  const url = request.url;
  const sha = request.headSha ? ` (commit ${request.headSha.slice(0, 7)})` : '';
  const branch = request.targetBranch;
  if (reason === 'CI failed')
    return `Pipeline failed on ${ref}${sha} (${url}). Look at the failing jobs and propose a fix.`;
  if (reason === 'changes requested') {
    const reviewers = request.awaitingReviewers.length
      ? request.awaitingReviewers.map((u) => `@${u}`).join(', ')
      : 'A reviewer';
    return `${reviewers} requested changes on ${ref} (${url}). Read the review and address it. Review comments may arrive in a separate message.`;
  }
  return `${ref} (${url}) has conflicts with \`${branch}\`. Rebase and resolve them.`;
}

export function needsYouToast(request: GitLabMergeRequest, reason: NeedsYouReason) {
  const ref = reference(request);
  if (reason === 'CI failed')
    return { title: `Pipeline failed on ${ref}`, message: 'Sent to the agent.' };
  if (reason === 'changes requested')
    return { title: `Changes requested on ${ref}`, message: 'Sent to the agent.' };
  return { title: `Conflicts on ${ref}`, message: 'Sent to the agent.' };
}

export function createNeedsYouWatcher(options: NeedsYouWatcherOptions) {
  const now = options.now ?? Date.now;
  const local = new Map<string, NeedsYouRecord | null>();
  const inflight = new Set<string>();

  return {
    async check(sessionID: string, request: ReviewRequest): Promise<void> {
      if (request.forge !== 'gitlab') return;
      const gitlab = request as GitLabMergeRequest;
      const key = needsYouKey(sessionID, request);
      if (inflight.has(key)) return;
      if (!options.current(sessionID, request)) return;

      const reason = needsYouReason(gitlab);
      const headSha = gitlab.headSha ?? '';

      if (!reason) {
        const had = local.has(key) ? local.get(key) : await options.record(key);
        if (had) {
          local.set(key, null);
          options.persist(key, undefined);
        } else {
          local.set(key, null);
        }
        return;
      }

      const stored = local.has(key) ? local.get(key) : await options.record(key);
      const changed = !stored || stored.reason !== reason || stored.headSha !== headSha;
      if (!changed) return;

      inflight.add(key);
      try {
        await options.send(sessionID, gitlab, reason);
        const record: NeedsYouRecord = { reason, headSha, at: now() };
        local.set(key, record);
        options.persist(key, record);
      } catch (error) {
        options.onSendError?.(error);
      } finally {
        inflight.delete(key);
      }
    },

    isExpired(record: NeedsYouRecord, at: number) {
      return at - record.at > RECORD_RETENTION;
    },
  };
}
