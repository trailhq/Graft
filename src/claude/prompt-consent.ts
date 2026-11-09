/**
 * The prompt hook's one door to consent (g5; design 1.5, 3.2 steps 4 and
 * 6.4): what an answer to a pending offer leaves in the session, and what a
 * save request leaves. g5 owns both: `captureAnswer` is the only place a
 * `yes` is recorded and `noteSaveRequest` the only place a save request is.
 * The prompt hook only calls them, inside its locked session, with the fold
 * from the same catch-up (Claude Code may write the typed line before the
 * hook runs, and then only that catch-up has its offset).
 *
 * An object, so the prompt tests can drive each answer class directly.
 */
import { captureAnswer, noteSaveRequest, type Captured } from '../skills/offer-moment.js';

export type { Captured };

export interface Consent {
  captureAnswer: typeof captureAnswer;
  noteSaveRequest: typeof noteSaveRequest;
}

export const consent: Consent = { captureAnswer, noteSaveRequest };
