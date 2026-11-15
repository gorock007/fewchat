/**
 * Worker entrypoint. Job processing lands in a later phase; for now it starts,
 * stays alive, and shuts down cleanly on SIGTERM/SIGINT.
 */
const idle = setInterval(() => {}, 60_000);

function shutdown(signal: NodeJS.Signals) {
  console.log(`worker stopping (${signal})`);
  clearInterval(idle);
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.log("worker started");
