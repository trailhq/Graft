/**
 * The lines `trail init` prints around a list it can't ask about (an agent
 * ran it): kept in a file of their own so the PreToolUse check can find the
 * list in a transcript without loading the rest of init.
 */

/**
 * The line an agent gets with the list: it shows it as written and waits. fix-lab5: it says what stays as it is and
 * why (the 1b lab's agent reworded the list), in D101's shape: a reason, never an order to recite.
 */
export const RELAY_LINE = "Show the list as written, each line's number, name and kind as they are, so the numbers the person types point at the items they mean. Wait for their answer, then run the command. Don't choose for them.";

/** The last line of the list. */
export const KEEP_LINE = "Keep: trail keep <numbers> · none: trail keep none";

/** The line after the list that shows one skill's steps in full (design 1.6); the number is the first skill's. */
export const DRAFT_LINE = "Show one in full: trail skills draft init-1 --print";
