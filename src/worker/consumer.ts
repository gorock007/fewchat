import {
  BeforeClaimError,
  processDelivery,
  type DeliveryDependencies,
} from "../delivery/process";

// https://developers.cloudflare.com/queues/platform/limits/
export const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

export type ConsumerDependencies = DeliveryDependencies & {
  /** Receives exactly one JSON line per message; no raw exceptions or payloads. */
  log?: (line: string) => void;
};

function deliveryIdOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const id = (body as Record<string, unknown>).deliveryId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)
    ? id
    : null;
}

/** D1 is authoritative; queue retries only accelerate work that is safe to retry. */
export async function handleDeliveryBatch(
  batch: MessageBatch<unknown>,
  deps: ConsumerDependencies,
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  for (const message of batch.messages) {
    const deliveryId = deliveryIdOf(message.body);
    let result: string;
    let errorClass: string | null = null;
    if (deliveryId === null) {
      result = "malformed";
      errorClass = "InvalidMessage";
      message.ack();
    } else {
      try {
        const processed = await processDelivery(deliveryId, deps);
        result = processed.result;
        errorClass = processed.errorClass ?? null;
        if (processed.result === "deferred") {
          const delaySeconds = Math.min(
            MAX_QUEUE_DELAY_SECONDS,
            Math.max(0, Math.ceil((processed.retryAt - deps.now()) / 1000)),
          );
          message.retry({ delaySeconds });
        } else {
          message.ack();
        }
      } catch (error) {
        result = "error";
        if (error instanceof BeforeClaimError) {
          errorClass = "BeforeClaimError";
          message.retry();
        } else {
          // Includes an ambiguous claim write: the sweep either rediscovers a
          // pending row or quarantines SENDING. It never resets an uncertain send.
          errorClass = "ClaimOrProcessingError";
          message.ack();
        }
      }
    }
    log(JSON.stringify({ deliveryId, result, errorClass }));
  }
}
