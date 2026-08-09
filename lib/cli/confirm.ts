/**
 * The typed confirmation in front of a command whose job is deletion.
 *
 * `tj` prompts for exactly one thing and only in one circumstance: a person is
 * at the keyboard, and something is about to be deleted. Everywhere else it
 * still refuses and names the flag, because a prompt that quietly turns into a
 * "no" under cron makes the safe path the one that only happens when somebody
 * is watching — and one that quietly turns into a "yes" is worse.
 *
 * So interactivity is judged by **stdin**, which is where the answer has to come
 * from, and never by stdout: `tj rm … --format json | jq` should still be able
 * to ask. For the same reason the caller writes the question to stderr, leaving
 * stdout to carry the result and nothing else.
 */

/** Nothing but this word will do. "y" is a keystroke, not a decision. */
const AFFIRMATION = 'yes';

export interface ConfirmIo {
  /** Whether there is a person to answer — stdin is a terminal. */
  isInteractive: boolean;
  /** Put the question where a person will see it and read back one line. */
  ask: (question: string) => Promise<string>;
}

export type ConfirmVerdict =
  | {ok: true}
  /** Refused, with the sentence to show for it. */
  | {ok: false; reason: string};

export function confirmationPrompt(summary: string): string {
  return `${summary}\nType "${AFFIRMATION}" to continue: `;
}

/**
 * Decide whether a destructive command may proceed.
 *
 * `preapproved` is `--yes`, which answers the question ahead of time and is the
 * only way through when nothing can be asked. Anything other than the word
 * itself — a bare return, "y", "no", an end-of-file — is a refusal, so leaning
 * on the keyboard cannot delete anything.
 */
export async function confirmDestructive(opts: {
  /** One line saying what is about to happen. */
  summary: string;
  /** `--yes` was given. */
  preapproved: boolean;
  /** What to say when there is nobody to ask. */
  flagHint: string;
  io: ConfirmIo;
}): Promise<ConfirmVerdict> {
  if (opts.preapproved) return {ok: true};
  if (!opts.io.isInteractive) return {ok: false, reason: opts.flagHint};

  let answer: string;
  try {
    answer = await opts.io.ask(confirmationPrompt(opts.summary));
  } catch {
    // The terminal went away mid-question (a closed pipe, a Ctrl-D): unanswered
    // is not agreed.
    return {ok: false, reason: 'Cancelled.'};
  }
  return answer.trim().toLowerCase() === AFFIRMATION
    ? {ok: true}
    : {ok: false, reason: 'Cancelled.'};
}
