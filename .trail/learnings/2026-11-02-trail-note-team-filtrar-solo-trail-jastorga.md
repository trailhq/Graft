---
title: "trail note --team: filtrar solo .trail/learnings/ en update automático"
author: Jastorga.externo
date: 2026-11-02
branch: main
id: l-303edda0
scope: repo
status: active
src: agent
touches:
  - "src/cli.ts#runNoteCommand"
---

## Watch out
El update automático de duplicados usaba searchSemantic sobre TODO el knowledge repo.
Los archivos .md fuente (sistemas/detafull/carta.md) también matchean con score > 0.55
y eran sobreescritos con el body del learning → perdida de contenido crítico.

## Decided
Filtrar strongMatch: score > 0.55 AND file_path.includes('.trail/learnings/')
Solo los learnings existentes se actualizan automáticamente.
Los archivos .md fuente (cartas de sistema, flujos, modulos) NUNCA se tocan — 
se actualizan manualmente o vía los touches del nuevo learning.
