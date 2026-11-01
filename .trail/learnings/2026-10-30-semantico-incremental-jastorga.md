---
title: "Embedding semantico incremental por body_hash"
touches:
  - src/ask/semantic.ts#embedNodes
author: jastorga
date: "2026-10-30"
---

## Decided

sqlite-vec NO soporta UPSERT (ON CONFLICT DO UPDATE) en tablas virtuales. Error: SQLITE_ERROR 'UPSERT not implemented for virtual table vss_nodes'. Solucion: DELETE + INSERT para vss_nodes, UPSERT normal para embed_nodes (tabla regular).

El embedding ahora es incremental: compara body_hash por nodo. Solo re-embeds los nodos que cambiaron.

## Watch out

- vss_nodes es tabla virtual: no soporta ON CONFLICT DO UPDATE. Siempre DELETE antes del INSERT.
- La columna body_hash en embed_nodes requiere migracion: ALTER TABLE con try/catch para idempotencia.
