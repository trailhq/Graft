/**
 * Scaffold a freshly-cloned knowledge repo with the standard directory
 * structure and template files that the team can fill in incrementally.
 *
 * Only runs when `knowledge/` does NOT already exist — idempotent.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface TemplateFile { path: string; content: string; }

const TEMPLATES: TemplateFile[] = [
  // ── global ───────────────────────────────────────────────────────────────
  {
    path: 'knowledge/global/development-flow.md',
    content: `# Development Flow

> Define the team's end-to-end development workflow here.
> This file is injected automatically at every Claude/Hermes session start.

## Principles

- **OpenSpec First**: every change starts with \`openspec propose\` → \`openspec apply\` → \`openspec archive\`.
- **KISS / YAGNI / DRY**: keep code simple; don't build what isn't needed yet.
- **Observability is not optional**: Jaeger, Seq and Prometheus must be complete even under KISS.

## Flow

1. Pick up a Jira ticket (MTD-XXX)
2. Create feature branch: \`feature/MTD-XXX-short-description\`
3. Run \`openspec propose\` and get approval before writing code
4. Implement → tests pass → build passes
5. Open MR against \`develop\` — never commit directly to \`develop\` or \`main\`
6. Archive the OpenSpec change after MR is merged

## Commands

\`\`\`bash
trail check          # verify your diff against team learnings before pushing
openspec status      # check change artifacts are complete
\`\`\`
`,
  },
  {
    path: 'knowledge/global/git-workflow.md',
    content: `# Git Workflow

> Define the team's git branching strategy and commit conventions here.

## Branch Names

| Type | Pattern | Example |
|---|---|---|
| Feature | \`feature/MTD-XXX-description\` | \`feature/MTD-287-bandeja-filtros\` |
| Fix | \`hotfix/MTD-XXX-description\` | \`hotfix/MTD-290-null-pointer\` |
| Release | \`release/vX.Y.Z\` | \`release/v1.4.0\` |

## Rules

- \`develop\` and \`main\` are **pull/fetch only** — never commit or push directly.
- Every change goes through a MR (Merge Request), not a direct push.
- Before opening a MR: \`tsc -b && npm run lint && npm run test\`
- MR title format: \`MTD-XXX: short description\`

## CI

- Calidad jobs run only on \`feature/\`, \`hotfix/\`, \`release/\` prefixes.
- \`fix/\` prefix does **not** trigger CI — use \`hotfix/\` instead.
`,
  },
  {
    path: 'knowledge/global/tech-stack.md',
    content: `# Tech Stack

> Document the team's technology choices and the reasons behind them.

## Frontend

| Layer | Technology | Notes |
|---|---|---|
| Framework | React + TypeScript | |
| Build | Vite | |
| Testing | Vitest | |
| State | (define here) | |

## Backend

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js / Bun | |
| Framework | (NestJS / Elysia) | |
| ORM | Prisma | |
| DB | PostgreSQL (Neon) | |

## Observability

| Tool | Purpose |
|---|---|
| Jaeger | Distributed tracing |
| Seq | Structured logs |
| Prometheus | Metrics |
`,
  },

  // ── skills (Hermes SKILL.md format) ──────────────────────────────────────
  {
    path: 'knowledge/agents/hermes/frontend-workflow.md',
    content: `---
name: frontend-workflow
description: "Use when developing frontend React features in DETACOOP apps."
category: team
triggers:
  - react development
  - frontend feature
  - vite
  - component
  - typescript frontend
---

# Frontend Development Workflow

> Complete with the team's frontend standards.

## Stack

- React + TypeScript + Vite
- Vitest for unit tests
- (Add component library, state management, etc.)

## Before Starting

1. \`openspec propose\` — get the spec approved first
2. Pull \`develop\`, create \`feature/MTD-XXX-description\`

## Conventions

- (Add naming conventions, file structure, import order, etc.)

## Testing

\`\`\`bash
npm run test          # run vitest
tsc --noEmit          # type check
npm run lint          # lint
\`\`\`

## Pitfalls

- (Add known pitfalls as the team discovers them)
`,
  },
  {
    path: 'knowledge/agents/hermes/backend-workflow.md',
    content: `---
name: backend-workflow
description: "Use when developing backend services in DETACOOP apps."
category: team
triggers:
  - backend development
  - api development
  - nestjs
  - elysia
  - prisma migration
---

# Backend Development Workflow

> Complete with the team's backend standards.

## Stack

- Node.js / Bun
- NestJS or Elysia
- Prisma + PostgreSQL (Neon)

## Before Starting

1. \`openspec propose\` — spec first
2. Check if a Prisma migration is needed (\`prisma migrate dev\`)

## Conventions

- (Add endpoint naming, DTO patterns, error handling, etc.)

## Pitfalls

- (Add known pitfalls)
`,
  },
  {
    path: 'knowledge/agents/hermes/openspec-workflow.md',
    content: `---
name: openspec-team-workflow
description: "Use for OpenSpec propose→apply→archive flow in DETACOOP projects."
category: team
triggers:
  - openspec
  - spec change
  - propose change
  - openspec archive
---

# OpenSpec Workflow (Team)

> Every code change starts here — no exceptions.

## Flow

\`\`\`bash
openspec propose        # creates proposal.md, specs/, design.md, tasks.md
# implement tasks, mark [x] as done
openspec validate       # all artifacts must pass
openspec archive        # sync specs → main, move to archive/
\`\`\`

## Rules

- No code before the proposal is approved by the team lead.
- All 4 artifacts (proposal, specs, design, tasks) must be complete before archiving.
- Use \`[x]\` (not ✓) to mark tasks done — the CLI only counts \`[x]\`.

## Pitfalls

- \`fix/\` branch prefix breaks CI — use \`hotfix/\` for fixes.
- \`mv\` fails on Windows MSYS: use \`cp -r + rm -rf\` for archive moves.
`,
  },

  // ── Claude-specific instructions ─────────────────────────────────────────
  {
    path: 'knowledge/agents/claude/WORKFLOW.md',
    content: `# DETACOOP Development Workflow for Claude Code

These are the standing rules for any Claude Code agent working on DETACOOP projects.

## Mandatory Rules

1. **Never commit to \`develop\` or \`main\`** — always use feature branches.
2. **OpenSpec first** — no code before \`openspec propose\` is approved.
3. **No mentions of TGT One / tgtone / @tgtone** in proposals, specs or package names.
4. **Before MR**: \`tsc -b && npm run lint && npm run test\` must all pass.

## Git Commands Before Every Commit

\`\`\`bash
git branch            # confirm you are NOT on develop or main
trail check           # check diff against team learnings
\`\`\`

## CI Branch Prefixes

Only \`feature/\`, \`hotfix/\`, \`release/\` trigger quality jobs.
\`fix/\` prefix → 0 jobs → pipeline fails. Use \`hotfix/\` instead.
`,
  },

  // ── apps placeholders ─────────────────────────────────────────────────────
  {
    path: 'knowledge/apps/detafull/architecture.md',
    content: `# Detafull Architecture

> Document the Detafull app architecture here.

## Repos

- \`default-core/frontend\` — React SPA
- \`default-core/backend\` — BFF
- \`default-core/api-preevualuacion\` — Core API
- \`default-core/openspec\` — Specs

## Key Concepts

- (Add domain concepts, entities, flows)

## OpenSpec Location

Each repo has its own \`openspec/\` at its root.
`,
  },
];

/**
 * Create the standard knowledge directory structure in a freshly cloned repo.
 * No-ops if `knowledge/` already exists.
 */
export function scaffoldKnowledgeRepo(repoDir: string): void {
  const knowledgeRoot = join(repoDir, 'knowledge');
  if (existsSync(knowledgeRoot)) return;

  for (const tpl of TEMPLATES) {
    const abs = join(repoDir, tpl.path);
    mkdirSync(join(repoDir, tpl.path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(abs, tpl.content, 'utf8');
  }

  // README at knowledge root
  writeFileSync(
    join(knowledgeRoot, 'README.md'),
    `# Team Knowledge Base

This directory contains the team's shared knowledge: development policies, agent skills, and app-specific documentation.

## Structure

| Directory | Contents |
|---|---|
| \`global/\` | Policies injected automatically at every agent session |
| \`agents/hermes/\` | Hermes skills (SKILL.md format) — synced to \`~/.hermes/skills/team/\` on \`trail init\` |
| \`agents/claude/\` | Instructions injected into Claude Code sessions |
| \`apps/<name>/\` | App-specific architecture and conventions |

## Updating

Edit any file → \`git commit\` → \`git push\`.
Each developer gets the updates on their next \`trail init\` or session start (auto-pull).
`,
    'utf8',
  );

  console.error(`✓ knowledge repo: scaffolded standard structure in ${repoDir}`);
  console.error(`  Edit knowledge/ files and commit to share with the team`);
}
