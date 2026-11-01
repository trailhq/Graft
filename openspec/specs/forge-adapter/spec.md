# forge-adapter Specification

## Purpose

Abstracción de proveedor git que detecta automáticamente el forge (GitHub, GitLab, Bitbucket, desconocido) desde la URL del remote `origin` y expone una interfaz uniforme para operaciones sobre PRs/MRs: verificar autenticación, leer MRs/PRs para el look-back de `trail init`, y listar ramas para tracking de ramas cerradas. Permite que trail funcione en repos de cualquier forge sin configuración manual.

## Requirements

### Requirement: Detección automática del forge desde la URL del remote

El sistema detecta el proveedor git (forge) a partir de la URL del remote `origin` del repositorio local, sin requerir configuración manual del usuario.

**Forges reconocidos:**
- `github.com` → GitHub
- Cualquier host que contenga `gitlab` en el dominio → GitLab
- `bitbucket.org` → Bitbucket
- Cualquier otra URL → desconocido (unknown)

La detección funciona tanto para remotes HTTPS (`https://gitlab.com/owner/repo.git`) como SSH (`git@gitlab.com:owner/repo.git`).

#### Scenario: Remote GitHub detectado como GitHub

GIVEN un repositorio con remote `origin` apuntando a `github.com`
WHEN el sistema consulta el forge del repositorio
THEN retorna forge `github`

#### Scenario: Remote GitLab detectado como GitLab

GIVEN un repositorio con remote `origin` apuntando a un host que contiene `gitlab` (cloud o self-hosted)
WHEN el sistema consulta el forge del repositorio
THEN retorna forge `gitlab`

#### Scenario: Remote desconocido degradado a unknown

GIVEN un repositorio con remote que no es GitHub, GitLab ni Bitbucket
WHEN el sistema consulta el forge del repositorio
THEN retorna forge `unknown` y el look-back de MRs/PRs se salta silenciosamente

### Requirement: Verificación de autenticación por forge

El sistema verifica si el CLI del forge correspondiente está instalado y autenticado antes de intentar leer MRs/PRs.

**CLI por forge:**
- GitHub → `gh auth token`
- GitLab → `glab auth status`

Si el CLI no está instalado o no está autenticado, la verificación retorna `false` y el look-back se omite sin error.

#### Scenario: gh instalado y autenticado en repo GitHub

GIVEN un repositorio GitHub y `gh` instalado y con sesión activa
WHEN el sistema verifica si puede leer PRs
THEN retorna `true`

#### Scenario: glab instalado y autenticado en repo GitLab

GIVEN un repositorio GitLab y `glab` instalado y con sesión activa
WHEN el sistema verifica si puede leer MRs
THEN retorna `true`

#### Scenario: CLI ausente en cualquier forge

GIVEN un repositorio de cualquier forge y el CLI correspondiente no instalado
WHEN el sistema verifica autenticación
THEN retorna `false` y el look-back se omite

### Requirement: Lectura de MRs/PRs recientes para look-back en trail init

Durante `trail init`, el sistema lee los MRs/PRs recientes del repositorio (fusionados y cerrados) para extraer learnings de lo que el equipo decidió y descartó.

La lectura usa el CLI del forge detectado. El contenido recuperado incluye descripción del MR/PR y comentarios de revisión.

#### Scenario: Look-back lee MRs de GitLab en trail init

GIVEN un repositorio GitLab con `glab` autenticado y MRs fusionados existentes
WHEN se ejecuta `trail init`
THEN el sistema lee hasta 50 MRs recientes vía `glab api graphql` y los procesa para extraer learnings

#### Scenario: Look-back lee PRs de GitHub igual que hoy

GIVEN un repositorio GitHub con `gh` autenticado y PRs fusionados existentes
WHEN se ejecuta `trail init`
THEN el sistema lee PRs vía `gh api graphql` exactamente igual que el comportamiento actual

#### Scenario: Look-back se omite si forge es unknown

GIVEN un repositorio con forge desconocido
WHEN se ejecuta `trail init`
THEN el look-back de MRs/PRs se omite silenciosamente sin error ni advertencia

### Requirement: Detección de señales de "ship" para forge no-GitHub

El sistema detecta comandos de creación/fusión de MR en GitLab (`glab mr create`, `glab mr merge`) como señales de que el trabajo está siendo publicado, equivalente a `gh pr create` en GitHub.

Esta detección alimenta: `trail check` pre-bash, el contador de sesiones para aprendizaje automático, y el registro de señales de "commit/push/ship".

#### Scenario: glab mr create dispara trail check

GIVEN una sesión con cambios pendientes y el agente ejecuta `glab mr create`
WHEN el hook pre-bash evalúa el comando
THEN `trail check` se ejecuta antes de continuar, igual que con `gh pr create`

#### Scenario: glab reconocido como comando seguro

GIVEN la lista de comandos permitidos por defecto en trail
WHEN el agente usa `glab` en cualquier comando
THEN `glab` es reconocido como herramienta segura (no bloqueada por los guardrails de riesgo)
