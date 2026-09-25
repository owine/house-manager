import { getEnv } from '@/lib/env';
import { type HeartbeatOptions, withHeartbeat } from '@/lib/heartbeat-ping';
import { handleRemindersTick } from './jobs/reminders-tick';
import { handleSearchReindex } from './jobs/search-reindex';

// The scheduled entry points that carry a dead-man ping. worker/index.ts's
// boss.work() callbacks call these, not the handlers directly, so the ping
// fires only from the cron path and only after a run that resolved.
//
// The startup missed-tick recovery in worker/index.ts deliberately calls
// handleRemindersTick directly: the monitor exists to prove that pg-boss cron
// keeps creating tick jobs and this worker keeps consuming them, and a ping
// on every boot would paper over a cron that has stopped.
//
// pg-dump keeps its own ping inside handlePgDump (it pings after pruning and
// reports the outcome in its result).
//
// What a ping proves differs per job. reminders.tick: the tick ran to the end.
// search.reindex: the rebuild was SUBMITTED without throwing. handleSearchReindex
// returns once Meilisearch has accepted its tasks (delete, settings, document
// batches); it does not wait for them to be processed, so the ping does not
// mean the index is populated.

type RemindersTickDeps = Parameters<typeof handleRemindersTick>[0];

export function runRemindersTick(deps: RemindersTickDeps, opts: HeartbeatOptions = {}) {
  return withHeartbeat(
    'reminders-tick',
    getEnv().REMINDERS_TICK_HEARTBEAT_URL,
    () => handleRemindersTick(deps),
    opts,
  );
}

export function runSearchReindex(opts: HeartbeatOptions = {}) {
  return withHeartbeat(
    'search-reindex',
    getEnv().SEARCH_REINDEX_HEARTBEAT_URL,
    () => handleSearchReindex(),
    opts,
  );
}
