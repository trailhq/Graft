---
title: "--in con workspaces compound: fix en federateAsk para matchear child más largo"
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-7c32970c
scope: repo
status: active
src: agent
touches:
  - src/graph/workspace.ts
---

## Decided
- El --in con paths compound (e.g. default-core/frontend) fallaba porque federateAsk() tomaba solo el primer segmento del path ('default-core') y lo buscaba en la lista de children — pero los children están registrados como 'default-core/frontend', nunca como 'default-core'.
- Fix: buscar el child más largo que sea prefijo exacto del --in value, usando filter + sort por longitud descendente. childIn es el remanente después del child path.
- El error original era: 'no workspace repo "default-core"' aunque el repo existe como 'default-core/frontend'.

## Watch out
- El hint que trail mismo genera en los resultados ('narrow with --in default-core/frontend/') era correcto pero la implementación no lo soportaba. Ahora sí.
- 'default-core' sin especificar el subrepo sigue fallando correctamente (ambiguo).
