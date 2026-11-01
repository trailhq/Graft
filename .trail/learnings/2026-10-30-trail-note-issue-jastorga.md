---
title: "trail note --issue: referencia generica a ticket"
touches:
  - src/notes/learning-fields.ts
  - src/notes/notes.ts
author: jastorga
date: "2026-10-30"
---

## Decided

Campo issue agregado a LearningFields, LEARNING_KEYS, WriteNoteInput y readLearningFields. Acepta cualquier referencia: MTD-287, numero de issue, URL completa.

## Watch out

- WriteNoteInput TAMBIEN debe incluir el campo. Si falta ahi, se descarta silenciosamente antes de llegar a renderNote.
- readLearningFields debe leer el campo explicitamente aunque este en LEARNING_KEYS.
