---
title: "Windows: execFileSync/spawnSync sin windowsHide abre 100+ ventanas CMD en trail init"
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-cd578323
scope: repo
status: active
src: agent
touches:
  - src/init/look-back-mine.ts
  - src/init/sessions.ts
  - src/notes/git-facts.ts
  - src/notes/pr-reviews.ts
---

## Decided
- Se creó src/util/child-process.ts que exporta WINHIDE = { windowsHide: true } en Windows y {} en otros OS, porque en Windows cada execFileSync/spawnSync sin windowsHide: true abre una ventana CMD visible — incluso los síncronos. Con 28 repos durante trail init se producían 100+ ventanas simultáneas.
- Se agrega ...WINHIDE a 43 llamadas en 28 archivos. Patrón: { ...WINHIDE, encoding: 'utf8', ... }.
- Los spawn() async ya tenían windowsHide: true en la mayoría; el problema real era execFileSync y spawnSync que se asumían silenciosos pero no lo son en Windows.

## Watch out
- Todo nuevo execFileSync o spawnSync en el fork debe importar WINHIDE de util/child-process.js y spreadearlo en las options, otherwise vuelven las ventanas en Windows.
- windowsHide es ignorado en Linux/macOS — no hay riesgo de regresión en otros sistemas.
- skills/probes.ts tiene un caso especial: el execFileSync tiene options en múltiples líneas, agregar ...WINHIDE como línea separada antes de env:.
