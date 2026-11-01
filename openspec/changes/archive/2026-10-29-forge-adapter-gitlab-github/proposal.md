# Proposal

## Why

Trail upstream asume GitHub en todos los repos: `ghReady()` en `src/notes/pr-reviews.ts` verifica `/github/i.test(remote)` y retorna `false` de inmediato si el remote es GitLab, Bitbucket u otro. DETACOOP usa GitLab exclusivamente, lo que hace que el look-back de MRs en `trail init`, la detección de señales de "ship" y la integración con ramas queden silenciosamente desactivados. Para que el fork sea usable como herramienta de equipo en DETACOOP — y potencialmente en otros clientes con distinto forge — la detección del proveedor git debe ser transparente y automática desde la URL del remote, sin configuración manual.

## What Changes

- **Nueva capa de abstracción `ForgeAdapter`** en `src/notes/forge.ts`: detecta el forge desde la URL del remote git y expone una interfaz uniforme para leer MRs/PRs.
- **Refactor de `ghReady()` → `forgeReady()`** en `src/notes/pr-reviews.ts`: deja de verificar "github" en el remote; pasa el adaptador correcto según el forge detectado.
- **Refactor de `fetchMergedPRs()`** para soportar GitLab (GraphQL vía `glab api graphql`) además de GitHub.
- **`src/notes/branches.ts`**: reemplaza `gh pr list` por llamada al adaptador de forge correspondiente (`glab mr list` en GitLab).
- **`src/claude/note-signals.ts`**: detecta `glab mr create` y `glab mr merge` como señales de "ship" además de `gh pr create`.
- **`src/claude/pre-bash-check.ts`**: agrega `glab mr create` a los comandos que disparan `trail check`.
- **`src/init/prefs.ts`**: agrega `glab` a la lista de comandos permitidos por defecto.
- **Backward-compatible**: repos GitHub siguen usando `gh` exactamente igual que hoy; el cambio solo activa rutas nuevas cuando el remote es GitLab u otro forge soportado.

## Capabilities

### New Capabilities

- `forge-adapter`: Abstracción de proveedor git que detecta automáticamente el forge desde la URL del remote (GitHub, GitLab, Bitbucket, desconocido) y expone una interfaz uniforme para operaciones sobre PRs/MRs: verificar autenticación, listar MRs/PRs recientes, leer reviews/comentarios. Permite que `trail init`, `trail check` y los hooks de señales funcionen en repos de cualquier forge sin configuración manual.

### Modified Capabilities

_(ninguna — no hay specs existentes en el fork)_

## Impact

- **`src/notes/pr-reviews.ts`**: `ghReady()` y `fetchMergedPRs()` refactorizados; `beginReviewRead()` recibe el adaptador.
- **`src/notes/forge.ts`**: archivo nuevo con `detectForge()`, interfaz `ForgeAdapter`, implementaciones `GitHubAdapter` y `GitLabAdapter`.
- **`src/notes/branches.ts`**: `gh pr list` reemplazado por llamada al adaptador.
- **`src/claude/note-signals.ts`**: regex de detección de comandos extendido.
- **`src/claude/pre-bash-check.ts`**: lista de comandos de "ship" extendida.
- **`src/init/prefs.ts`**: lista segura de comandos extendida con `glab`.
- **Dependencias externas**: `glab` CLI (GitLab CLI) debe estar instalado en el sistema para repos GitLab; si no está, el comportamiento degrada igual que hoy con `gh` ausente en repos GitHub.
- **Sin cambios en la API pública de MCP ni en los tipos de learnings.**
