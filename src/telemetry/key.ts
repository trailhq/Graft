/**
 * The PostHog project key, and the reason forks stay silent.
 *
 * `BAKED_KEY` is empty in the repository and is rewritten in place by
 * `scripts/stamp-telemetry-key.mjs`, which runs from `prepublishOnly`. So the
 * key exists only in the published tarball: a clone, a fork, and a plain
 * `npm run build` all compile to `''`, and every send path short-circuits. A
 * contributor cannot accidentally send us their own usage, and a fork cannot
 * send us anything at all.
 *
 * `GRAFT_POSTHOG_KEY` overrides it at runtime so a maintainer can exercise the
 * real path locally without publishing.
 *
 * Public project keys are write-only ingestion keys — they authorise capture and
 * nothing else — which is why one may sit in a published artifact at all. It is
 * still not committed here: an empty default is what makes "forks never send"
 * true by construction rather than by policy.
 */

/** Rewritten at publish time. Do not hand-edit — see the module comment. */
const BAKED_KEY = '';

/**
 * Nanonets' own PostHog host, not `us.i.posthog.com`.
 *
 * Every Nanonets product ingests through a nanonets.com proxy rather than
 * PostHog directly, on one shared project token, so pointing graft at PostHog
 * Cloud would put its events in a project nobody looks at.
 *
 * `events.` rather than `e.` because graft is server-side, and this is the host
 * the other server-side integration already uses (the agents-platform Go
 * backend sets `POSTHOG_HOST=https://events.nanonets.com`). The one documented
 * objection to it — 400 `invalid_payload` — was gzip-compressed ingest from
 * `posthog-js` in a browser, fixed there with `disable_compression: true`. We
 * send plain uncompressed JSON from Node, so that failure mode cannot apply.
 *
 * Probed directly, that host answers 401 to a well-formed batch with a bad key,
 * so it serves `/batch/` and parses the body — see the note in send.ts.
 *
 * The HOST is safe to commit; the KEY is not, and stays empty here. That
 * asymmetry is the point: with no key, a fork built from this source sends
 * nothing no matter where the host points.
 */
const BAKED_HOST = 'https://events.nanonets.com';

export function posthogKey(): string {
  return process.env.GRAFT_POSTHOG_KEY || BAKED_KEY;
}

export function posthogHost(): string {
  return (process.env.GRAFT_POSTHOG_HOST || BAKED_HOST).replace(/\/+$/, '');
}
