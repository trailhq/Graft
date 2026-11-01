# Design

## Contexto

Trail upstream hardcodea GitHub en cuatro puntos: `ghReady()` filtra por `/github/i` en el remote, `fetchMergedPRs()` llama a `gh api graphql`, `branches.ts` usa `gh pr list`, y `note-signals.ts` detecta solo `gh pr create`. Ver `proposal.md – Why` para la motivación completa.

## Goals / Non-Goals

**Goals:**
- Detectar GitHub, GitLab y Bitbucket automáticamente desde la URL del remote, sin configuración
- Rutas GitLab funcionales en `trail init` (look-back de MRs), hooks de señales y branches
- Backward-compatible: repos GitHub siguen usando `gh` exactamente igual

**Non-Goals:**
- Soporte de Bitbucket en esta iteración (detectado pero sin implementación de lectura de PRs)
- Autenticación o configuración de credenciales del forge (responsabilidad del usuario con `gh auth` / `glab auth`)
- Soporte de forges self-hosted con dominio arbitrario más allá de GitLab (cubierto por detección por substring)

## Enfoque

### Nuevo módulo: `src/notes/forge.ts`

Centraliza la detección y el adaptador. Expone:

```typescript
type ForgeKind = "github" | "gitlab" | "bitbucket" | "unknown";

interface ForgeAdapter {
  kind: ForgeKind;
  cli: string;                         // "gh" | "glab" | "bb"
  isReady(repo: string): boolean;      // verifica CLI + auth
  fetchReviews(repo: string, timeoutMs: number): Promise<unknown>;  // MRs/PRs
  listBranches(repo: string): SpawnSyncReturns<string>;
}

function detectForge(repo: string): ForgeKind;
function makeAdapter(repo: string): ForgeAdapter;
```

**Detección** (`detectForge`):
```typescript
function detectForge(repo: string): ForgeKind {
  const out = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], ...);
  const url = out.stdout.toString().trim();
  if (/github\.com/i.test(url))    return "github";
  if (/gitlab\./i.test(url))       return "gitlab";
  if (/bitbucket\.org/i.test(url)) return "bitbucket";
  return "unknown";
}
```

### Adaptador GitHub (`GitHubAdapter`)

Reimplementa el comportamiento actual sin cambios de comportamiento:
- `isReady`: `spawnSync("gh", ["auth", "token"], ...)` + verifica exit 0
- `fetchReviews`: `spawn("gh", ["api", "graphql", ...])` con la query GraphQL existente
- `listBranches`: `execFileSync("gh", ["pr", "list", ...])` igual que hoy

### Adaptador GitLab (`GitLabAdapter`)

GraphQL de GitLab está disponible en `/api/graphql`. `glab` lo expone como `glab api graphql -f query='...'`.

Query equivalente en GitLab GraphQL:
```graphql
query($fullPath: ID!, $merged: Int!, $closed: Int!) {
  project(fullPath: $fullPath) {
    mergeRequests(state: merged, first: $merged, sort: UPDATED_DESC) {
      nodes { title description createdAt mergedAt
        notes { nodes { body author { username } } } }
    }
    closedMergeRequests: mergeRequests(state: closed, first: $closed, sort: UPDATED_DESC) {
      nodes { title description createdAt
        notes { nodes { body author { username } } } }
    }
  }
}
```

El `fullPath` se extrae del remote URL: `gitlab.com/owner/repo` → `owner/repo`.

- `isReady`: `spawnSync("glab", ["auth", "status"], { stdio: "ignore" })` + verifica exit 0
- `fetchReviews`: `spawn("glab", ["api", "graphql", "-f", `query=...`])` con WINHIDE
- `listBranches`: `execFileSync("glab", ["mr", "list", "--state", "all", "--output", "json"])` con WINHIDE

### Refactor de archivos existentes

| Archivo | Cambio |
|---|---|
| `src/notes/pr-reviews.ts` | `ghReady(repo)` → `forgeReady(repo)` que llama a `makeAdapter(repo).isReady(repo)`. `fetchMergedPRs(repo, gh, ms)` → `fetchMergedPRs(repo, adapter, ms)`. `beginReviewRead` detecta forge internamente con `makeAdapter`. |
| `src/notes/branches.ts` | L169: `execFileSync("gh", ["pr", "list", ...])` → `makeAdapter(repo).listBranches(repo)` |
| `src/claude/note-signals.ts` | Regex existente `/gh pr create/` extendido a `/(?:gh pr create\|glab mr create\|glab mr merge)/` |
| `src/claude/pre-bash-check.ts` | Lista de comandos de "ship" extendida con `glab mr create` |
| `src/init/prefs.ts` | Lista segura L213: agregar `'glab'` junto a `'gh'` |

### Degradación cuando el forge es unknown

Si `detectForge` retorna `"unknown"`, `makeAdapter` retorna un `UnknownAdapter` cuyo `isReady()` siempre retorna `false`. `beginReviewRead` retorna `null` (mismo comportamiento que hoy cuando `gh` no está instalado).

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `glab` no instalado en la máquina | `isReady()` retorna false → look-back omitido silenciosamente. Mismo comportamiento que `gh` ausente hoy. |
| GitLab self-hosted con dominio sin "gitlab" | Detección falla → `unknown`. En esos casos, el usuario puede hacer fork del adaptador o esperar detección por heurística futura. |
| Diferencias en estructura JSON de la respuesta GraphQL de GitLab | El extractor de learnings (`bar.ts`) opera sobre texto plano, no sobre JSON tipado de GitHub — el adaptador normaliza la respuesta a la misma forma que el GitHub adapter. |
| Regresión en repos GitHub | El `GitHubAdapter` es un refactor sin cambio de comportamiento; los tests de `pr-reviews` existentes cubren el camino GitHub. |
