---
title: trail build semantic es default en el fork — usar --no-semantic para saltar
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-806c4e02
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
---

## Decided
- trail build incluye el paso semántico por defecto, porque tenerlo opt-in (--semantic) significaba que trail init y los builds de hooks nunca lo construían.
- La flag cambió de --semantic a --no-semantic. Commander genera semantic=true por defecto con .option('--no-semantic'); otherwise habría que pasar --semantic en cada build manual y en el init.
- trail init se beneficia automáticamente: cuando corre trail build internamente ya incluye embeddings.

## Watch out
- Primer build descarga modelo ~87MB a ~/.cache/huggingface/transformers, solo una vez.
- Repos con 0 nodos indexables (openspec con solo .md): paso semántico termina sin error.
- CI donde el tiempo importa: trail build --no-semantic.
