---
title: "Trail: --in falla con workspaces de nombre compuesto (ej. default-core/frontend)"
author: Jastorga.externo
date: 2026-10-29
branch: feat/semantic-search
id: l-c652b9c5
scope: repo
status: active
src: agent
touches:
  - package-lock.json
  - src/app/checkout.ts
  - src/blast/blast-cli.ts
  - src/blast/diff.ts
  - src/blast/owners.ts
  - src/check/learning-edits.ts
  - src/claude/build-progress.ts
  - src/claude/note-signals.ts
  - src/claude/pre-bash-check.ts
  - src/claude/pre-bash.ts
---

trail_find_code y trail_find_all con --in 'default-core/frontend' fallan con 'no workspace repo default-core' porque Trail parsea el primer segmento como root. El hint 'narrow with --in default-core/frontend/' que el propio Trail imprime es incorrecto para compound names. Repos de nombre simple (Biometria, Scandes) sí funcionan. Workaround: omitir --in y filtrar manualmente por el label [default-core/frontend/] en el output.
