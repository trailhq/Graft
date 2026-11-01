---
title: "trail note --team: redirige learning al knowledge repo + auto commit+push"
author: Jastorga.externo
date: 2026-11-01
branch: feat/semantic-search
id: l-a24d0bc3
scope: repo
status: active
src: agent
touches:
  - "src/cli.ts#runNoteCommand"
---

## Decided
--team busca el knowledge repo via findWorkspaceRoot, redirige el note ahí, y hace git add .trail/learnings/ && git commit && git push.

## Watch out
- git add con path absoluto falla en Windows. Usar path relativo: .trail/learnings/
- El warning de múltiples repos muestra el orden y cuál se va a usar (el primero)
- Si el workspace root no es git repo (ej. Desarrollo/), el file existe localmente pero no viaja a git; documentar en README del knowledge repo
