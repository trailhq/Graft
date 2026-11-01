---
title: "windowsHide: true en todos los spawns del fork — evita ventanas CMD en Windows"
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-1ddf340b
scope: repo
status: active
src: agent
touches:
  - src/init/claude-call.ts
  - src/notes/pr-reviews.ts
  - src/graph/lsp/client.ts
---

## Decided
- Se agregó windowsHide: true a todos los spawns que no lo tenían, porque en Windows cada spawn de un proceso hijo sin esa opción abre una ventana CMD visible — durante trail init con un workspace grande aparecían múltiples ventanas simultáneas.
- Archivos corregidos: src/init/claude-call.ts (look-back de sesiones Claude), src/notes/pr-reviews.ts (consulta de PRs con gh), src/graph/lsp/client.ts (language server).
- telemetry/flush.ts y upkeep.ts ya tenían windowsHide: true correctamente. Los spawns de src/cloud/ (other-repos.ts, pair.ts) se dejaron sin modificar porque Trail Cloud no se usa en el fork.

## Watch out
- Cualquier spawn nuevo que se agregue al fork debe incluir windowsHide: true, otherwise vuelven las ventanas en Windows.
- windowsHide es ignorado silenciosamente en Linux/macOS — no hay riesgo de regresión en otras plataformas.
