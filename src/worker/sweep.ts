import { pendingDeliveries, quarantineStaleSending } from "../db/deliveries";
import { touchLastSweep } from "../db/settings";
import {
  BeforeClaimError,
  processDelivery,
  type DeliveryDependencies,
} from "../delivery/process";

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
  processed: Record<string, number>;
  errors: Record<string, number>;
};

export type SweepDependencies = DeliveryDependencies & {
  /** Receives exactly one JSON line per tick: counts only. */
  log?: (line: string) => void;
};

/**
 * One cron tick, the path that still works when the queue does not (ADR 0002
 * Decision 3): quarantine stale `SENDING` rows, process the oldest few overdue
 * pending rows inline and in order, stamp `last_sweep_at`, log counts.
 */
export async function runSweep(
  deps: SweepDependencies,
  { now }: { now: number },
): Promise<SweepSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const summary: SweepSummary = { quarantined: 0, processed: {}, errors: {} };

  const stale = await quarantineStaleSending(deps.db, {
    now,
    limit: SWEEP_QUARANTINE_LIMIT,
  });
  summary.quarantined = stale.length;

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
