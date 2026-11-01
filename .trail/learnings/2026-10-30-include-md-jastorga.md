---
title: "trail build --include-md: parseo de archivos .md"
touches:
  - src/graph/markdown.ts
  - src/util/state.ts
  - src/graph/source-files.ts
author: jastorga
date: "2026-10-30"
---

## Decided

Flag --include-md persistido en .graft/config.json (campo includeMd en BuildConfig). Opt-in para no afectar repos de codigo puros.

## Watch out

- NodeV1.span es REQUERIDO con formato L1-L50. Sin el, trail ask crashea con 'Cannot read properties of undefined'.
- NodeV1.summary_state debe ser 'none' para nodos nuevos.
- kind 'section' no es Kind oficial: usar cast 'as unknown as NodeV1[kind]'.
