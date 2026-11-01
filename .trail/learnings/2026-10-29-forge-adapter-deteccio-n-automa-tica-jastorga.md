---
title: "forge-adapter: detección automática GitHub/GitLab desde remote URL"
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-95372e10
scope: repo
status: active
src: agent
touches:
  - src/notes/pr-reviews.ts
  - src/notes/branches.ts
  - src/claude/pre-bash.ts
  - src/init/prefs.ts
---

## Decided
- Se creó src/notes/forge.ts con ForgeKind, ForgeAdapter, GitHubAdapter, GitLabAdapter, UnknownAdapter y makeAdapter(), porque trail upstream hardcodeaba gh CLI y filtraba repos no-GitHub silenciosamente — DETACOOP usa GitLab y el look-back de MRs nunca corría.
- detectForge() lee git remote get-url origin y detecta github/gitlab/bitbucket por substring del dominio, sin configuración manual.
- GitLabAdapter.fetchReviews normaliza la respuesta GraphQL de GitLab al mismo shape que GitHub (data.repository.merged/closed) para que reviewedPRs() funcione sin modificación.
- GitLabAdapter.listBranches normaliza glab mr list --output json a {headRefName, headRefOid, state: 'OPEN'|'MERGED'|'CLOSED'} para que closedPrHeads() funcione sin modificación.
- SHIP regex en note-signals.ts y pre-bash.ts extendido con glab mr create|merge; glab agregado a COMMON_PROGRAMS en prefs.ts.

## Watch out
- GitLabAdapter.fetchReviews extrae fullPath del remote URL via repoFullPath() — si el remote usa SSH con host custom sin 'gitlab' en el dominio, detectForge() retorna 'unknown' y el look-back se omite silenciosamente.
- glab mr list --output json en algunas versiones de glab puede retornar campos distintos. Verificar con glab 1.119+ que source_branch y sha están presentes.
