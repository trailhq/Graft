---
title: "buildGraphWithProgress: timeout dinámico por repo y windowsHide en Windows"
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-6bf51c6e
scope: repo
status: active
src: agent
touches:
  - src/claude/build-progress.ts
---

## Decided
- Timeout del build en trail init cambió de 300_000ms fijo a dinámico: min(max(childCount × 10min, 10min), 120min), porque 5 minutos era insuficiente para workspaces grandes con embedding semántico por defecto. Un workspace de 28 repos fallaba consistentemente.
- Se agregó windowsHide: true al spawn del proceso hijo, porque en Windows cada spawn sin esa opción abre una ventana CMD visible — con 28 repos durante trail init aparecían múltiples ventanas que asustaban al usuario.
- Se agregó childCount al tipo de opts para que el caller pueda pasar el número de repos hijos.

## Watch out
- El caller (cli.ts) debe pasar childCount: children.length al llamar buildGraphWithProgress, otherwise el timeout cae al mínimo de 10 min (1 repo).
- El cap de 120 min aplica a workspaces de 12+ repos — suficiente para cualquier caso real con embeddings.
