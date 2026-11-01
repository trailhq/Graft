# Tasks

## forge-adapter-gitlab-github

### T1 — Módulo forge.ts: detección y adaptadores

- [x] Crear `src/notes/forge.ts` con tipo `ForgeKind = "github" | "gitlab" | "bitbucket" | "unknown"`
- [x] Implementar `detectForge(repo: string): ForgeKind` usando `git remote get-url origin` con WINHIDE
- [x] Definir interfaz `ForgeAdapter` con métodos `isReady`, `fetchReviews`, `listBranches`
- [x] Implementar `GitHubAdapter` extrayendo la lógica actual de `pr-reviews.ts` y `branches.ts` sin cambio de comportamiento
- [x] Implementar `GitLabAdapter.isReady` con `glab auth status` (exit 0 = autenticado) con WINHIDE
- [x] Implementar `GitLabAdapter.fetchReviews` con `glab api graphql` y la query GraphQL de GitLab; normalizar respuesta al mismo shape que GitHub
- [x] Implementar `GitLabAdapter.listBranches` con `glab mr list --state all --output json` con WINHIDE
- [x] Implementar `UnknownAdapter` con `isReady()` siempre `false` y métodos que retornan vacío
- [x] Exportar `makeAdapter(repo: string): ForgeAdapter` que llama `detectForge` y retorna el adaptador correcto

### T2 — Refactor pr-reviews.ts

- [x] Reemplazar `ghReady(repo)` por `forgeReady(repo)` que llama `makeAdapter(repo).isReady(repo)`
- [x] Refactorizar `fetchMergedPRs(repo, gh, ms)` para recibir un `ForgeAdapter` en vez del string `gh`
- [x] Actualizar `beginReviewRead` para usar `makeAdapter` internamente en lugar de recibir `gh = "gh"`
- [x] Mantener la firma externa de `beginReviewRead` backward-compatible (el parámetro `gh` puede quedar como override opcional)
- [x] Verificar que todos los imports de WINHIDE estén presentes

### T3 — Refactor branches.ts

- [x] Reemplazar `execFileSync("gh", ["pr", "list", ...])` (L169) por `makeAdapter(repo).listBranches(repo)`
- [x] Parsear el output del adapter igual que se parsea hoy el output de `gh`

### T4 — Señales de ship en note-signals.ts y pre-bash-check.ts

- [x] En `note-signals.ts`: extender la regex de detección de `gh pr create` para incluir `glab mr create` y `glab mr merge`
- [x] En `pre-bash-check.ts`: agregar `glab mr create` a la lista de comandos que disparan `trail check` antes de ejecutar
- [x] Verificar que el verbo en el log de sesión sea correcto para comandos glab ("abrió un MR para")

### T5 — Lista segura en prefs.ts

- [x] Agregar `'glab'` junto a `'gh'` en la lista de comandos seguros (L213)

### T6 — Build y reinstall

- [x] `npm run build` — verificar sin errores de TypeScript
- [x] `npm install -g . --ignore-scripts` — reinstalar el fork globalmente
- [x] Verificar `trail --version` muestra `0.28.0-semantic.1`

### T7 — Prueba manual en repo GitLab

- [x] En `default-core/backend` (remote GitLab): ejecutar `trail init --no-build --yes` y verificar que el look-back de MRs intenta conectarse con `glab` (o lo omite limpiamente si `glab` no está auth)
- [x] Verificar con `glab auth login` que el look-back de MRs de GitLab produce output en `trail init`
- [x] En un repo GitHub (si disponible): verificar que el comportamiento no cambió

### T8 — Learning en Trail-Code

- [x] Documentar el adaptador de forge con `trail note` en el repo Trail-Code con `--touches src/notes/forge.ts`
