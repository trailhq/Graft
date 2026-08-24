# The graft GitHub App

Posts a blast-radius comment on every pull request, and hosts the interactive
graph behind a signed link.

It exists because of one limit that no amount of workflow YAML gets around: **a
`pull_request` job on a fork gets a read-only token**, so it cannot comment, and
`pull_request_target` cannot check out fork code without opting into running it.
An App's installation token belongs to the *base* repository, so a fork PR is
ordinary work. Two things follow for free: the page is served by the App (a
private repo never needs a public `gh-pages`), and installing takes one click
instead of a workflow file per repo.

## What it does per pull request

1. Verifies the webhook signature, queues the job, answers `202` — GitHub gives
   up on a delivery after ten seconds and a review takes longer.
2. Fetches `refs/pull/<n>/merge` and the base branch, shallow.
3. Builds the structural graph, computes the radius, renders the comment.
4. Stores the viewer page and links it with a signed URL.
5. Edits its existing comment rather than adding one per push.

Work is superseded per pull request: five pushes in a minute produce one review,
not five, because the first four comments would be overwritten anyway.

## Setting it up

### 1. Register the App

<https://github.com/settings/apps/new> (or your org's settings → Developer
settings → GitHub Apps → New).

| Field | Value |
| --- | --- |
| Webhook URL | `https://<your-host>/webhook` |
| Webhook secret | a long random string — keep it, it is `GRAFT_WEBHOOK_SECRET` |
| Repository permissions | **Contents: Read-only**, **Pull requests: Read & write** |
| Subscribe to events | **Pull request** |
| Where can this be installed | your choice |

Nothing else. Contents-read is what clones the code; pull-requests-write is what
posts the comment. It never needs Actions, Checks, Administration or write
access to code.

Then **Generate a private key** — the download is the only copy — and note the
**App ID**.

### 2. Run it

```bash
docker build -t graft-app .
docker run -p 3000:3000 \
  -e GRAFT_APP_ID=123456 \
  -e GRAFT_APP_PRIVATE_KEY="$(cat graft.private-key.pem)" \
  -e GRAFT_WEBHOOK_SECRET=... \
  -e GRAFT_PUBLIC_URL=https://graft.example.com \
  graft-app
```

The image needs `git` and nothing else at runtime, runs as non-root, and answers
`/healthz` with its queue depth. Any container host works — Fly, Cloud Run, ECS,
a VM. `GRAFT_PUBLIC_URL` must be the origin GitHub and your reviewers can reach,
because it is what the comment's link is built from.

The process refuses to start if any of those four are missing: a server that
boots without a webhook secret looks healthy and silently rejects every delivery.

### 3. Install it on a repository

App settings → Install App → pick the repos. **Installing requires admin on the
repository** (or org-owner for an org-wide install) — the one thing an App does
not get you around.

## Security

The App clones code written by strangers on every fork PR while holding a token
for the base repository, so:

- **Nothing from the repo is executed** — no `npm install`, no build step, no
  postinstall. The graph comes from tree-sitter reading source text.
- **Git is told not to run anything either**: `core.hooksPath=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, no submodule recursion.
- **The token never lands in the checkout.** It is passed per-invocation as an
  auth header, not baked into a remote URL that `.git/config` and the reflog
  would keep. It is redacted out of error text before anything is logged.
- **Pages are capabilities, not public URLs.** `/p/<id>?t=<hmac>` — an unknown
  page and a bad token are both `404`, so the endpoint cannot be used to
  discover which pull requests exist. Links expire with the page they point at.

## What is not built yet

- **Naming.** Areas fall back to their hub symbol. `--name`'s one cached LLM call
  is not wired in, and sending a private repo's source to a model should be an
  explicit per-installation opt-in, not a default.
- **Persistence.** Pages live in memory, so a deploy drops them; the next push to
  a PR rebuilds its page. A shared store is the fix when there is more than one
  instance.
- **The evidence quotes** in the comment's collapsed list arrive when #180 lands
  (`markdownReport(report, { root })` — additive, one line here).
