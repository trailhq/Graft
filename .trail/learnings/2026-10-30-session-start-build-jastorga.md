---
title: "SessionStart: build en background desde carpeta de sesion"
touches:
  - src/claude/hooks.ts
author: jastorga
date: "2026-10-30"
---

## Decided

Al inicio de sesion, spawn trail build <dir> como proceso detached con windowsHide:true. El dir es el directorio del proyecto activo, no el workspace global.

## Watch out

- Usar brand() === 'trail' en lugar de constante TRAIL (no disponible en hooks.ts).
- graftCliPath() importar dinamicamente desde './paths.js'.
- Siempre: detached + stdio:'ignore' + windowsHide:true + child.unref().
