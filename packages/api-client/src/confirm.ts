/*
  A person's yes, as the home asks for it: an answer that wants one hands out
  a token, good once, for a minute, and why — `needsConfirmation` and
  `reason`, the same on every answer that may want one. The screens ask in
  the platform's own dialog (`Ask`); what is asked, and asking again when a
  yes came too late, is here, once. Pure, so it is tested without a screen.
*/

/**
 * How much a yes can cost, and so how its button looks: `careful` — it does
 * something real, worth a second look (let an automation act, switch off what
 * draws) — or `dangerous` — it cannot be undone, or can harm the hardware
 * (delete, erase, a setting declared dangerous, a tool that says what it
 * cannot undo).
 */
export type ConfirmTone = 'careful' | 'dangerous';

/** One question for a person: its title, what it says, the button that says yes, and how much a yes costs. */
export type Question = { title: string; message: string; yes: string; tone?: ConfirmTone };

/** How a person is asked, and their answer: the platform's own dialog. */
export type Ask = (question: Question) => Promise<boolean>;

/**
 * Said when a yes no longer counted and the question is asked again. Usually
 * it came after its minute; it may also be that the home restarted.
 */
export const ASKED_AGAIN = 'That yes no longer counted: a yes lasts a minute. Here is the question again, with how things are now.';

/** What an answer that wants a yes hands out: the token the yes is sent back with, and why it is wanted. */
export type WantsYes = { token: string; reason: string };

/** Whether an answer wants a person's yes: its token and its reason (a gateway's verdict says why in its `detail`). */
export const wantsYes = (answer: object): WantsYes | null => {
  const said = answer as { needsConfirmation?: string | null; reason?: string; detail?: string };
  return said.needsConfirmation ? { token: said.needsConfirmation, reason: said.reason ?? said.detail ?? '' } : null;
};

/**
 * Sends what the home may want a person's yes for, and asks them for as long
 * as it does. The yes it hands out lasts a minute; a person who took longer
 * gets its fresh question — asked again, saying so, since what it is about
 * may have changed — rather than a failure. `answer` is the last one;
 * `declined`, that the person said no to it.
 */
export async function withConfirmation<R extends object>(
  send: (confirmation?: string) => Promise<R>,
  question: (reason: string) => Question,
  ask: Ask,
  wants: (answer: R) => WantsYes | null = wantsYes
): Promise<{ answer: R; declined: boolean }> {
  let answer = await send();
  for (let again = false; ; again = true) {
    const wanted = wants(answer);
    if (!wanted) return { answer, declined: false };
    const asked = question(wanted.reason);
    if (!(await ask(again ? { ...asked, message: `${ASKED_AGAIN}\n\n${asked.message}` } : asked))) return { answer, declined: true };
    answer = await send(wanted.token);
  }
}
