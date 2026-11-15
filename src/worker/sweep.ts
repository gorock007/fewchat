import { pendingDeliveries, quarantineStaleSending } from "../db/deliveries";
import { touchLastSweep } from "../db/settings";
import {
  BeforeClaimError,
  processDelivery,
  type DeliveryDependencies,
} from "../delivery/process";
import { refreshDueToken, type RefreshDependencies } from "./refresh";

/**
 * Rows processed inline per tick. Each is a D1 claim, one Meta call and a D1
 * write, and a Worker invocation has 50 subrequests (ADR 0002 Step 1 gate 3).
 */
export const SWEEP_BATCH_LIMIT = 5;

/** Rows the queue is about to handle are not due long enough to be taken here. */
export const SWEEP_OVERDUE_MS = 60 * 1000;

const SWEEP_QUARANTINE_LIMIT = 25;

export type SweepSummary = {
  quarantined: number;
  refreshed: number;
  refresh_failed: number;
  processed: Record<string, number>;
  errors: Record<string, number>;
};

// `DeliveryDependencies.meta` only names `sendPrivateReply`, but the client that
// `deliveryDependencies` builds is the whole thing, so `refreshToken` is read
// through an optional type here rather than by changing the delivery types.
export type SweepDependencies = Omit<DeliveryDependencies, "meta"> & {
  meta: DeliveryDependencies["meta"] & Partial<RefreshDependencies["meta"]>;
  /** Receives exactly one JSON line per tick: counts only. */
  log?: (line: string) => void;
};

/**
 * One cron tick, the path that still works when the queue does not (ADR 0002
 * Decision 3): quarantine stale `SENDING` rows, refresh one due token, process the oldest few overdue
 * pending rows inline and in order, stamp `last_sweep_at`, log counts.
 */
export async function runSweep(
  deps: SweepDependencies,
  { now }: { now: number },
): Promise<SweepSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const summary: SweepSummary = {
    quarantined: 0,
    refreshed: 0,
    refresh_failed: 0,
    processed: {},
    errors: {},
  };

  const stale = await quarantineStaleSending(deps.db, {
    now,
    limit: SWEEP_QUARANTINE_LIMIT,
  });
  summary.quarantined = stale.length;

  // At most one account per tick, so Meta's token endpoint costs the tick one
  // subrequest. A throw here must not stop the sends below.
  try {
    const refresh = await refreshDueToken(
      {
        ...deps,
        meta: {
          // Throws, so it counts as a RefreshError, only if a token is due and
          // the client has no refreshToken: never silently skipped.
          refreshToken: (...args) => {
            if (!deps.meta.refreshToken)
              throw new Error("Meta client has no refreshToken");
            return deps.meta.refreshToken(...args);
          },
        },
      },
      { now },
    );
    if (refresh === "refreshed") summary.refreshed = 1;
    if (refresh === "failed") summary.refresh_failed = 1;
  } catch {
    summary.errors.RefreshError = 1;
  }

  const due = await pendingDeliveries(deps.db, {
    now: now - SWEEP_OVERDUE_MS,
    limit: SWEEP_BATCH_LIMIT,
  });
  // Sequential: the cap is about subrequests, and order keeps oldest first.
  for (const { id } of due) {
    try {
      const { result } = await processDelivery(id, deps);
      summary.processed[result] = (summary.processed[result] ?? 0) + 1;
    } catch (error) {
      // Fixed classes only: a D1 or provider error message can carry bound values.
      const errorClass =
        error instanceof BeforeClaimError
          ? "BeforeClaimError"
          : "ClaimOrProcessingError";
      summary.errors[errorClass] = (summary.errors[errorClass] ?? 0) + 1;
    }
  }

  await touchLastSweep(deps.db, now);
  log(JSON.stringify({ event: "sweep", ...summary }));
  return summary;
}
