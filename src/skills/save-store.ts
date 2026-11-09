/**
 * What the save gate reads from the skill store (g4), without changing it:
 * where a name is taken, which runs are already kept, and the run a held
 * item was kept from (D65: a live save for the same run replaces it).
 */
import type { SkillState } from './types.js';
import { allHeld } from './store-held.js';
import { readSkillsState } from './state.js';

export { nameTaken } from './store.js';

/** The skills state's entries; {} when it can't be read. */
export function readSkillsStateSafe(env?: NodeJS.ProcessEnv): Record<string, SkillState> {
  try {
    return readSkillsState(env).skills;
  } catch {
    return {};
  }
}

/** The run id a held item of this name was kept from (`HeldItem.runId`); null when there is none or it doesn't say. */
export function heldRunId(name: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    return allHeld(env).find((h) => h.name === name)?.runId ?? null;
  } catch {
    return null;
  }
}
