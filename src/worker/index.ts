import { app } from "./app";

export default {
  fetch: app.fetch,

  async queue(batch) {
    // Delivery processing lands in a later phase; ack so nothing redelivers.
    for (const message of batch.messages) message.ack();
  },

  async scheduled(controller) {
    // The sweep of stuck deliveries lands in a later phase.
    console.log(
      JSON.stringify({
        event: "scheduled",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    );
  },
} satisfies ExportedHandler<Env>;
