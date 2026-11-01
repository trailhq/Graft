---
title: "knowledge-repos: .trail/knowledge-repos.json commiteable"
author: Jastorga.externo
date: 2026-11-01
branch: feat/semantic-search
id: l-60d6e779
scope: repo
status: active
src: agent
touches:
  - "src/graph/workspace.ts#readKnowledgeRepos"
---

## Decided
knowledge-repos.json vive en .trail/ del directorio raíz (workspace o repo), NO en .trail/cache/ que es git-ignored.
Esto permite que el archivo sea commiteable cuando el dir raíz es un git repo.

findWorkspaceRoot busca primero knowledge-repos.json (cualquier dir), luego workspace.json con knowledgeRepos.
Funciona en 3 casos: workspace multi-repo, repo único, varios repos sin workspace.

## Watch out
- .trail/cache/workspace.json es git-ignored → NO guardar config ahí
- .graft/ era la ubicación legacy → auto-migra a .trail/config.json en el primer write
- ensureBuildConfigIgnored: ignorar solo /.trail/config.json, NOT /.trail/ entero (learnings y hooks deben commitearse)
