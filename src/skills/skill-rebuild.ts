/**
 * A SKILL.md back to the CompiledSkill that renders it (phase 2 design 4.4,
 * P11). A skill's fields depend on each other (the steps, `confirm-before`,
 * `needs`, the check line's "Step N", `version`), so a fold never edits the
 * text: it rebuilds the CompiledSkill, changes its steps and renders again.
 * That is only safe when the renderer gives back exactly the file Trail
 * wrote, so `rebuildCompiled` returns null unless the round trip is byte for
 * byte. `rebuildLoose` reads a hand-edited file as Trail reads it, for a
 * proposal beside it (4.6); nothing it returns is ever written over that file.
 *
 * Pure: no disk. The source and the helper names come from the caller (the
 * skill's state and its scripts/ folder).
 */
import type { CompiledSkill, ParsedSkill, SkillState } from './types.js';
import { renderSkillMd, skillHash } from './skillmd.js';

/** The `# ` heading after the front matter, or null. */
function titleOf(text: string): string | null {
  const lines = String(text ?? '').split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (i < 0) return null;
    i++;
  }
  for (; i < lines.length; i++) {
    const m = /^#\s+(.*?)\s*$/.exec(lines[i]!);
    if (m) return m[1]!;
    if (/^##\s/.test(lines[i]!)) return null;
  }
  return null;
}

/** The line under "## Check it worked": "Step N, `…`, is the check" or "`…` is the check" means the check is a step. */
function checkReadsAsStep(text: string): boolean {
  const m = /\n## Check it worked\s*\n([^\n]*)/.exec(String(text ?? ''));
  return !!m && /^(?:Step \d+, )?`.*`,? is the check\b/.test(m[1]!);
}

function base(parsed: ParsedSkill, title: string, checkIsStep: boolean, source: CompiledSkill['source'], helpers: CompiledSkill['helpers']): CompiledSkill {
  const check = parsed.check ?? '';
  return {
    name: parsed.name,
    title,
    description: parsed.description,
    meta: { ...parsed.meta },
    steps: parsed.steps.map((s) => ({ n: s.n, cmd: s.cmd, gated: s.gated, bg: s.bg, wait: s.wait })),
    check,
    checkShows: check ? parsed.checkShows : null,
    checkIsStep: checkIsStep && !!check,
    ifFails: [...parsed.ifFails],
    dontUse: parsed.dontUse,
    params: parsed.params.map((p) => ({ ...p, seen: [...p.seen] })),
    helpers,
    leftOut: { failed: 0, lookOnly: 0, duplicates: 0, plumbing: 0, work: 0 },
    source,
  };
}

/**
 * A SKILL.md Trail wrote, back to the CompiledSkill that renders it. null unless renderSkillMd(result) === text exactly,
 * or when `parsed` is not this text's parse. `helpers` are the names in scripts/ (content '': a fold never writes
 * scripts/, 4.5); `runId` is the state's run, when the caller has it.
 */
export function rebuildCompiled(text: string, parsed: ParsedSkill, extra: { source: SkillState['source']; helpers: string[]; runId?: string | null }): CompiledSkill | null {
  try {
    const src = String(text ?? '');
    if (!parsed || parsed.hash !== skillHash(src)) return null;
    const title = titleOf(src);
    if (title === null) return null;
    const s = extra?.source;
    const source = { runId: String(extra?.runId ?? ''), commands: s?.commands ?? 0, failed: s?.failed ?? 0, at: s?.at ?? '' };
    const helpers = (extra?.helpers ?? []).filter((f) => typeof f === 'string' && f).map((file) => ({ file, from: `scripts/${file}`, content: '' }));
    const first = checkReadsAsStep(src);
    for (const asStep of [first, !first]) {
      const c = base(parsed, title, asStep, source, helpers);
      if (renderSkillMd(c) === src) return c;
    }
    return null;
  } catch {
    return null;
  }
}

/** Same, without the exact round trip: for a proposal beside a hand-edited file (4.6). null when it has no steps. */
export function rebuildLoose(text: string, parsed: ParsedSkill): CompiledSkill | null {
  try {
    if (!parsed || !parsed.steps.length) return null;
    const src = String(text ?? '');
    return base(parsed, titleOf(src) ?? parsed.name, checkReadsAsStep(src), { runId: '', commands: 0, failed: 0, at: '' }, []);
  } catch {
    return null;
  }
}
