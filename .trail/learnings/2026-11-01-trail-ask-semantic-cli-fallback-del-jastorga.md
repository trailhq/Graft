---
title: "trail ask --semantic: CLI fallback del MCP trail_search_semantic"
author: Jastorga.externo
date: 2026-11-01
branch: feat/semantic-search
id: l-7abd1220
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
---

## Decided
Agrega --semantic a trail ask. Federa sobre children si es workspace, busca en single repo si no.
Equivalente exacto de trail_search_semantic MCP. Usar cuando MCP no está disponible.

## Watch out
- El threshold 0.05 puede filtrar demasiado en queries conceptuales → bajar o hacerlo configurable
- Workspace: iterar children y prefixar file_path con child name para evitar ambigüedad
