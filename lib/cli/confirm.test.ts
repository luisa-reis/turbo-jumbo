import {test, expect} from 'bun:test';
import {
  confirmDestructive,
  confirmationPrompt,
  type ConfirmIo,
} from '@/lib/cli/confirm';

const HINT = 'tj rm needs --yes to confirm, since it deletes files.';

/** A person at the keyboard who types `answer`. */
const typing = (answer: string): ConfirmIo & {asked: string[]} => {
  const asked: string[] = [];
  return {
    isInteractive: true,
    asked,
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
  };
};

const noTerminal: ConfirmIo = {
  isInteractive: false,
  ask: async () => {
    throw new Error('must not ask when there is nobody to answer');
  },
};

const confirm = (io: ConfirmIo, preapproved = false) =>
  confirmDestructive({
    summary: 'This deletes 15 file(s).',
    preapproved,
    flagHint: HINT,
    io,
  });

test('typing the word lets it through', async () => {
  const io = typing('yes');
  expect(await confirm(io)).toEqual({ok: true});
  expect(io.asked[0]).toContain('This deletes 15 file(s).');
  expect(io.asked[0]).toContain('"yes"');
});

test('the word is accepted however it was capitalised or spaced', async () => {
  for (const answer of ['YES', 'Yes', '  yes  ', 'yes\n']) {
    expect(await confirm(typing(answer))).toEqual({ok: true});
  }
});

test('anything short of the word is a refusal', async () => {
  // "y" is a keystroke, not a decision; a bare return is the accident this
  // exists to catch.
  for (const answer of ['y', 'Y', '', '\n', 'no', 'yes please', 'ok']) {
    expect(await confirm(typing(answer))).toEqual({
      ok: false,
      reason: 'Cancelled.',
    });
  }
});

test('--yes answers ahead of time, and nothing is asked', async () => {
  const io = typing('no'); // would refuse if it were consulted
  expect(await confirm(io, true)).toEqual({ok: true});
  expect(io.asked).toEqual([]);
});

test('with nobody to ask it refuses and names the flag', async () => {
  // Under cron a prompt has no one to answer it. Turning that into a "yes"
  // would delete unattended; turning it into a silent "no" would hide why.
  expect(await confirm(noTerminal)).toEqual({ok: false, reason: HINT});
});

test('--yes still works with nobody to ask — that is what it is for', async () => {
  expect(await confirm(noTerminal, true)).toEqual({ok: true});
});

test('a terminal that disappears mid-question is not agreement', async () => {
  const gone: ConfirmIo = {
    isInteractive: true,
    ask: async () => {
      throw new Error('EOF');
    },
  };
  expect(await confirm(gone)).toEqual({ok: false, reason: 'Cancelled.'});
});

test('the question says what will happen and what to type', () => {
  const q = confirmationPrompt(
    'This deletes 3 file(s) of Foo from cold storage.',
  );
  expect(q).toContain('This deletes 3 file(s) of Foo from cold storage.');
  expect(q).toMatch(/Type "yes" to continue: $/);
});
