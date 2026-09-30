import { Alert, Platform } from 'react-native';

/**
 * How much a yes can cost, and so how its button looks: `careful` — it does
 * something real, worth a second look (let an automation act, switch off what
 * draws) — or `dangerous` — it cannot be undone, or can harm the hardware
 * (delete, erase, a setting declared dangerous, a tool that says what it
 * cannot undo). Only a dangerous yes is drawn in the danger colour.
 */
export type ConfirmTone = 'careful' | 'dangerous';

/** One question for a person, and where their answer goes. */
export type ConfirmRequest = { title: string; message: string; confirmLabel: string; tone: ConfirmTone; resolve: (yes: boolean) => void };

let host: ((request: ConfirmRequest) => void) | null = null;

/** Where the app draws its questions: `ConfirmHost`, mounted at the root. */
export function setConfirmHost(next: ((request: ConfirmRequest) => void) | null): void {
  host = next;
}

/**
 * Asks before something consequential happens, and waits for the answer.
 *
 * On a phone, its own alert. On the web, the app's own dialog (`ConfirmHost`):
 * the browser's `confirm` answers no at once, showing nothing, wherever dialogs
 * are suppressed, and everything that needed a yes silently did not happen.
 */
export function confirmAction(title: string, message: string, confirmLabel = 'Continue', tone: ConfirmTone = 'careful'): Promise<boolean> {
  if (Platform.OS === 'web') {
    if (host) {
      const ask = host;
      return new Promise((resolve) => ask({ title, message, confirmLabel, tone, resolve }));
    }
    // Before the app has mounted its own: the browser's, the only one there is.
    // eslint-disable-next-line no-alert
    return Promise.resolve(typeof confirm === 'function' ? confirm(`${title}\n\n${message}`) : false);
  }
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: tone === 'dangerous' ? 'destructive' : 'default', onPress: () => resolve(true) },
    ])
  );
}

/**
 * Said when a yes no longer counted and the question is asked again. Usually
 * it came after its minute; it may also be that the server restarted.
 */
export const ASKED_AGAIN = 'That yes no longer counted: a yes lasts a minute. Here is the question again, with how things are now.';

/**
 * Sends what the server may want a person's yes for, and asks them for as long
 * as it does. The yes the server hands out lasts a minute; a person who took
 * longer gets its fresh question — asked again, since what it is about may
 * have changed — rather than a failure. `answer` is the last one; `declined`,
 * that the person said no to it.
 */
export async function withConfirmation<R>(
  send: (confirmation?: string) => Promise<R>,
  wants: (answer: R) => { token: string; reason: string } | null,
  ask: (reason: string, again: boolean) => Promise<boolean>
): Promise<{ answer: R; declined: boolean }> {
  let answer = await send();
  for (let again = false; ; again = true) {
    const wanted = wants(answer);
    if (!wanted) return { answer, declined: false };
    if (!(await ask(wanted.reason, again))) return { answer, declined: true };
    answer = await send(wanted.token);
  }
}
