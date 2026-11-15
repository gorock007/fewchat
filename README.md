# FewChat

**Less automation. Just what you need.**

FewChat is a lightweight, open-source, self-hosted tool that sends an Instagram
DM when someone comments a keyword on your post or Reel, using Meta's official
Instagram API (comments webhook + Private Replies). No follow gating, no flow
builder, no subscription.

> **Status: early development.** Nothing here is usable yet. The live Meta
> integration has not been validated. See [`docs/PRD.md`](docs/PRD.md) for the
> full spec and plan.

## Development

FewChat runs as one Cloudflare Worker that serves the dashboard (a Next.js
static export in `out/`), the `/api` routes, the queue consumer and the cron
sweep, on D1. See [`docs/adr/0002-free-first-cloudflare.md`](docs/adr/0002-free-first-cloudflare.md).

Prerequisites: Node 24 and pnpm. `wrangler login` is needed only to deploy.

```sh
pnpm install
pnpm dev:worker          # builds out/, then serves the Worker at http://localhost:8787
curl localhost:8787/api/health   # {"ok":true}
pnpm db:migrate:local    # applies migrations/ to the local D1 database
pnpm dev                 # UI only: next dev, no Worker
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Copy `.dev.vars.example` to `.dev.vars` for local secrets (git-ignored). After
changing `wrangler.jsonc`, run `pnpm cf:types` to regenerate
`worker-configuration.d.ts`, and commit it; run it without a `.dev.vars` so the
file doesn't depend on your local secrets. `pnpm test` includes Worker tests
that run in Miniflare; the asset tests need `out/` from `pnpm build` and skip
with a warning without it.

The IDs in `wrangler.jsonc` are placeholders (this repo is public). For a real
deploy, put your own D1 `database_id` and any other account-specific settings in
a git-ignored `wrangler.deploy.jsonc` and pass it with `wrangler --config`.
There is no deploy guide yet.

### Seeding for the live test

Until the dashboard and OAuth exist, `pnpm seed` puts your Instagram account and
one automation into D1 so the Step 3 live Meta test can run. It needs
`TOKEN_ENCRYPTION_KEY` and `META_GRAPH_API_VERSION` from the environment or
`.dev.vars`, and the migrations applied (`pnpm db:migrate:local`).

```sh
# The long-lived token goes on stdin, never a flag.
pbpaste | pnpm seed account
pnpm seed automation --media <media id> --keyword guide --url https://example.com/guide
```

For the deployed database, add `--remote --config wrangler.deploy.jsonc` to both
commands, with the same `TOKEN_ENCRYPTION_KEY` as the deployed Worker. Run
`pnpm seed --help` for every flag. Running `account` again replaces the token;
`automation` deactivates any other active automation on the same media. Once
connected, the cron sweep refreshes the token before it expires.

## License

[MIT](LICENSE)
