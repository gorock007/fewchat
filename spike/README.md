# Cloudflare free-tier spike (throwaway)

Evidence for [ADR 0002](../docs/adr/0002-free-first-cloudflare.md). Not part of the app: fake data only, no Meta calls, own lockfile.

```bash
# from the repo root: build the static export the Worker serves
NEXT_OUTPUT=export pnpm build            # writes ../out (git-ignored)

cd spike
pnpm install --frozen-lockfile
pnpm test                                 # 13 Miniflare integration tests
pnpm bench                                # local CPU microbenchmarks (Node, relative only)
pnpm db:local && pnpm dev                 # wrangler dev --test-scheduled
```

Deployed measurement: copy `wrangler.jsonc` to a git-ignored `wrangler.deploy.jsonc` (never commit it), put the real D1 id in it, set
`SPIKE_ENABLED` to `remote`, `MOCK_URL` to `https://fewchat-spike.<subdomain>.workers.dev/__spike/mock`, add a
self service binding named `MOCK` (`"services": [{ "binding": "MOCK", "service": "fewchat-spike" }]`) and a
`SPIKE_ACCESS_KEY` secret. Then run `SPIKE_URL=… SPIKE_KEY=… pnpm smoke` while `wrangler tail --format json` records `cpuTime`.

`PROCESSING_MODE` (`queue` or `waitUntil`) selects the dispatch path. The `/webhook`, `/login` and `/__spike/*` routes are
reachable only from loopback (`local`) or with the access key (`remote`).
