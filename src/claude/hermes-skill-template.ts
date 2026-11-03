/**
 * Hermes-specific trail skill template.
 *
 * Hermes (Nous Research) reads skills from its own profile directory
 * (~/.hermes/skills/ or %LOCALAPPDATA%/hermes/skills/) and requires YAML
 * frontmatter with name/description/category/triggers.
 *
 * This is separate from the Claude Code skill (skill-template.ts) because
 * the formats differ. Content mirrors the Claude Code skill but uses the
 * Hermes frontmatter schema.
 */
import { inBrand, type Brand } from "../brand.js";

export function hermesSkillTemplate(brand: Brand = "graft"): string {
  const b = brand === "trail" ? "trail" : "graft";
  return inBrand(`---
name: trail
description: >
  Use for ANY task in a trail-indexed repo. Runs trail ask before exploring,
  saves learnings with trail note after sessions, checks trail before committing.
  Use when: working in repos with .trail/ wired, code search needed, blast radius
  analysis, or looking up what past sessions decided.
category: devops
triggers:
  - trail ask / trail grep / trail callers / trail map
  - trail note / trail check / trail blast
  - code search in graft-indexed repos
  - looking up decisions from past sessions
  - understanding blast radius before a change
---

# trail — código y memoria de sesión

## Cuándo usar trail

- **Antes de explorar código**, corrí \`trail ask "<tarea>" --source\` — incluso para
  "¿dónde está X?" o "¿cómo funciona Y?", antes de hacer grep o abrir archivos.
- **Al empezar desde un ticket o bug**, corrí \`trail ask\` con sus palabras antes
  de planificar — puede haber decisiones previas sobre esa área.
- **Antes de cambiar un símbolo**, usá \`trail callers <sym>\` para ver el blast radius.
- **Cuando la sesión encuentre algo que el código no puede decirle al próximo**,
  guardalo con \`trail note\`, commitealo con el cambio.
- **Antes de commitear/pushear/abrir un MR**, corré \`trail check\`.

## Herramientas MCP — cuál usar según el caso

| Tool | Para qué | Cuándo |
|---|---|---|
| \`trail_find_code\` | Búsqueda léxica | **Código**: funciones, símbolos, variables, clases |
| \`trail_find_all\` | Grep exhaustivo | Todas las ocurrencias de un literal |
| \`trail_trace_calls\` | Grafo de llamadas | Blast radius antes de cambiar algo |
| \`trail_file_api\` | Firmas del archivo | Ver API sin leer el archivo completo |
| \`trail_search_semantic\` | Búsqueda conceptual | **Solo specs/docs/knowledge** en lenguaje natural |
| \`trail_repo_map\` | Mapa del workspace | Orientarse en un repo desconocido |
| \`trail_check_freshness\` | Estado del índice | Antes de buscar si no se ha buildeado |
| \`trail_build\` | Rebuild índice | Cuando freshness reporta stale |

> **Regla clave sobre semántico**: \`trail_search_semantic\` SOLO aporta valor en archivos \`.md\`
> (specs OpenSpec, cartas de sistema, knowledge repos). Para código TypeScript/C#/Python
> **usar siempre \`trail_find_code\`** — el modelo de embeddings no entiende tokens de código.
>
> ✅ \`trail_search_semantic("cómo funciona la cuota mínima")\` → encuentra specs
> ❌ \`trail_search_semantic("retomarCopiaEnProceso")\` → no matchea código
> ✅ \`trail_find_code("retomarCopiaEnProceso")\` → encuentra el símbolo exacto

En workspaces con repos compound (ej. \`default-core/frontend\`), usar path completo:
\`trail_find_code(query="...", in="default-core/frontend")\` — \`in="default-core"\` no es válido.

## CLI equivalente (cuando el servidor MCP no está activo)

\`\`\`
trail ask "<pregunta>" --source     # localizar + entender
trail grep "<literal>"              # exhaustivo — todas las ocurrencias
trail callers <sym> --depth 2       # blast radius antes de cambiar
trail skeleton <archivo>            # API del archivo en ~200 tokens
trail map                           # orientación del workspace
\`\`\`

## Guardar un learning

Guardar cuando la sesion encuentre algo que el codigo no puede decirle al proximo.

\`\`\`bash
trail note --title "decision en palabras simples" \\
  --touches "src/archivo.ts#Funcion" \\
  --issue "MTD-287"   # ticket Jira, GitLab (#134), GitHub o URL completa
  -m "## Decided\\n..."
\`\`\`

## Scope en workspace grande

**Siempre usar \`--in\` o el parametro \`in=\` para acotar al repo correcto.**
Sin el, las busquedas federan sobre todos los repos del workspace (~20+), trayendo
hits de repos de otros clientes o proyectos no relacionados.

\`\`\`
# MCP — siempre con in=
trail_find_code(query="EvaluacionDetalle", in="default-core/frontend")
trail_search_semantic(query="cuota minima envio", in="default-core")

# CLI fallback
trail ask "EvaluacionDetalle" --in default-core/frontend/
\`\`\`

## Visualizacion del grafo

\`\`\`bash
trail viz                              # abre el browser en localhost:4400
trail viz --repos frontend backend     # solo esos repos del workspace
trail viz --skip detafull openspec     # todos menos esos
trail viz --include-tests              # tests visibles (ocultos por defecto)
trail viz --export out/                # HTML estatico para CI o GitHub Pages
\`\`\`

## Indexar .md (cartas de sistema, glosario)

\`\`\`bash
trail build --include-md    # activa indexacion .md persistida
trail ask "tasa efectiva"   # ahora encuentra cartas de sistema
trail build --no-include-md # revertir
\`\`\`

## Antes de publicar el trabajo

Ejecutar **en este orden** antes del primer push de cualquier rama:

\`\`\`bash
<typecheck>                              # ej. tsc -b (TS), go vet, cargo check, mypy
<lint>                                   # ej. bun run lint / npm run lint
<tests>                                  # ej. npx vitest run <módulo>
trail check --base origin/<base>         # blast radius: conflictos con otras ramas y learnings
\`\`\`

\`trail check\` va **al final**, antes del push — no después del MR.
Si detecta solapamiento con otra rama activa, avisarle al reviewer en la descripción del MR.

\`\`\`bash
trail check           # verifica el diff contra learnings del equipo
trail check --base origin/develop   # contra otro branch
\`\`\`

## Configuración del servidor MCP (Hermes)

El servidor trail debe estar registrado en la config de Hermes:

**Windows:**
\`\`\`yaml
mcp_servers:
  trail:
    command: C:/Users/<user>/AppData/Roaming/npm/trail.cmd
    args:
      - mcp
      - C:/ruta/al/workspace
    env:
      PYTHONUTF8: "1"
\`\`\`

**Linux / WSL / macOS:**
\`\`\`yaml
mcp_servers:
  trail:
    command: trail
    args:
      - mcp
      - /ruta/al/workspace
\`\`\`

Si \`trail\` no está instalado: \`npm install -g trail-code-detacoop --ignore-scripts\`
`, brand);
}
