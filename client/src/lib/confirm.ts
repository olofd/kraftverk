import { Alert, Platform } from 'react-native';

/**
 * Asks before something consequential happens, and waits for the answer.
 *
 * `Alert` does not exist on the web, where the browser's own `confirm` is the
 * honest equivalent: both block until the person has actually decided.
 */
export function confirmAction(title: string, message: string, confirmLabel = 'Continue'): Promise<boolean> {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    return Promise.resolve(typeof confirm === 'function' ? confirm(`${title}\n\n${message}`) : false);
  }
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
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
