import { startMock } from "./harness.mjs";
const mock = await startMock(8799);
console.log("Fake Meta mock listening on loopback port 8799");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await mock.close(); process.exit(0); });
