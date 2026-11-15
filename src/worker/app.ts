import { Hono } from "hono";

import { webhook } from "./webhook";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api/webhooks/instagram", webhook);

// Only worker-first paths reach Hono, so an unmatched one is a real 404, not
// a request for a static asset.
app.notFound((c) => c.json({ error: "not_found" }, 404));
