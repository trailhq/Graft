---
title: "trailSpelling reemplaza graft_ tool names — skill-template usa @detacoop/trail-code"
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-ef6763af
scope: repo
status: active
src: agent
touches:
  - src/claude/skill-template.ts
---

## Decided
- trailSpelling() ahora incluye .replace(/\bgraft_(?=[a-z])/g, 'trail_') antes del replace de graft como palabra, porque el fork expone los tools MCP como trail_* (no graft_*) y sin este reemplazo la skill generada mostraba graft_find_code etc. al usuario.
- @trailhq/trail-code reemplazado por @detacoop/trail-code en los install hints de skill-template.ts, otherwise el agente instruye a instalar el paquete upstream en vez del fork.
- El comentario de trailSpelling decía explícitamente que graft_… names se dejaban; actualizado para documentar la excepción del fork.

## Watch out
- Después de cambiar skill-template.ts: npm run build + npm install -g . --ignore-scripts + trail init --no-build --yes en al menos un repo para regenerar ~/.claude/skills/trail/SKILL.md.
- Verificar: grep 'graft_\|@trailhq' ~/.claude/skills/trail/SKILL.md — debe retornar vacío.
