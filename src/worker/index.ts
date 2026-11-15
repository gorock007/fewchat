import { app } from "./app";
import { handleDeliveryBatch } from "./consumer";
import { deliveryDependencies } from "./deps";
import { runSweep } from "./sweep";

function logConfigError(event: string) {
  console.log(JSON.stringify({ event, error: "invalid_config" }));
}

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    let deps;
    try {
      deps = deliveryDependencies(env);
    } catch {
      // The error names the missing settings; one fixed line is enough.
      logConfigError("queue_config_error");
      for (const message of batch.messages) message.retry();
      return;
    }
    await handleDeliveryBatch(batch, deps);
  },

  async scheduled(_controller, env) {
    let deps;
    try {
      deps = deliveryDependencies(env);
    } catch {
      logConfigError("sweep_config_error");
      return;
    }
    await runSweep(deps, { now: deps.now() });
  },
} satisfies ExportedHandler<Env>;
