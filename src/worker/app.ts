import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// Only worker-first paths reach Hono, so an unmatched one is a real 404, not
// a request for a static asset.
app.notFound((c) => c.json({ error: "not_found" }, 404));
