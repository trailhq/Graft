/**
 * The init handover (design 3.1 step 10, 4.8, J02 leg C), for b7's
 * SessionStart to call: when a relay's list waits unanswered, the next
 * interactive session in this repo gets the same list once, numbers
 * unchanged, titles rebuilt from the record (a preference's line read again
 * by its pointer), and the record notes that session and its transcript's
 * size, from which the keep gate reads (R22). A later session says nothing
 * and drops the list: its items become never-shown (P10).
 *
 * Light on purpose (it runs inside the SessionStart budget): the record, at
 * most 5 positioned reads, no replay or compile. When a list waits to be
 * handed over, the session's own transcript tail is read once (keep-list's
 * `findList`): the session that showed the list, resumed, is not handed it
 * again (fix-lab5).
 */
import { statSync } from 'node:fs';
import { directive } from '../skills/directive-words.js';
import { HOOK_RECORD_WAIT_MS, readInitRecord, updateInitRecord, type PendingItem } from './init-record.js';
import { leadWords, replyNamesList } from './keep-answer.js';
import { isInitCommand } from './keep-gate.js';
import { findList, typedLine } from './keep-list.js';
import { prefText } from './prefs.js';
import { fill, INIT_COPY, relayBlock, repoNameOf } from './review-screen.js';
import type { InitItem } from './types.js';

/**
 * A pending item as the relay shows it again: its plain name, or the person's line read now by its pointer (title ''
 * when that line is gone). Shared with `trail keep`, which names the same items.
 */
export function pendingAsItem(p: PendingItem, env: NodeJS.ProcessEnv): InitItem {
  let title = p.plainName;
  if (p.kind === 'preference') {
    const ref = p.pref?.refs[0];
    const text = ref ? typedLine(ref, env) : null;
    title = text ? prefText(text).slice(0, 120) : '';
  }
  return {
    ...p, title, description: '', evidence: [], rank: 0, nameWords: p.kind === 'preference' ? leadWords(title) : p.nameWords,
    ...(p.skill ? { skill: { src: p.skill.src, ...(p.skill.branches ? { branches: p.skill.branches } : {}) } as unknown as NonNullable<InitItem['skill']> } : {}),
  } as InitItem;
}

/** This session's transcript already holds a clean `trail init` call's list naming every pending item. */
function holdsList(path: string | null, all: InitItem[]): boolean {
  if (!path) return false;
  const found = findList(path, isInitCommand, null);
  const list = found?.list;
  return !!list && list.via === 'init-call' && replyNamesList(list.text, all.map((i) => ({ n: i.n, nameWords: i.nameWords })));
}

/**
 * The context to add at this session's start, or null. Writes the record: `handedAt` and `handover` the first time;
 * `pending` dropped when another session already had it. Never throws.
 */
export function initHandover(repoKey: string, session: { id: string; transcriptPath: string | null }, env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()): string | null {
  try {
    const r = readInitRecord(repoKey, env);
    if (!r.pending.length || !r.shownAt || !r.pendingFrom) return null;
    if (r.handedAt) {
      if (r.handover?.session !== session.id) {
        updateInitRecord(repoKey, (x) => {
          x.pending = [];
          x.pendingFrom = null;
          x.shownAt = null;
          x.handedAt = null;
          x.handover = null;
        }, env, HOOK_RECORD_WAIT_MS);
      }
      return null;
    }
    const items = r.pending.slice(0, 5).map((p) => pendingAsItem(p, env)).filter((x) => x.title !== '');
    if (!items.length) return null;
    // fix-lab5: the session that showed this list, resumed (every `claude -p` turn is one), already holds it. Handing
    // it over again would make the person's next typed line read as before the list. Another session still gets it.
    if (holdsList(session.transcriptPath, r.pending.map((p) => pendingAsItem(p, env)))) return null;
    let offset = 0;
    try {
      offset = session.transcriptPath ? statSync(session.transcriptPath).size : 0;
    } catch { /* no transcript yet: from its start */ }
    updateInitRecord(repoKey, (x) => {
      x.handedAt = now.toISOString();
      x.handover = { session: session.id, offset };
    }, env, HOOK_RECORD_WAIT_MS);
    const block = relayBlock(items, repoNameOf(repoKey), true);
    return [directive(null, fill(INIT_COPY.handover!, { k: items.length })), ...block.slice(1)].join('\n');
  } catch {
    return null;
  }
}
