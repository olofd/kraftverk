import { Alert, Platform } from 'react-native';

import type { Ask, ConfirmTone } from '@kraftverk/api-client';

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

/** A question asked in the platform's own dialog, as the home's yes-wanting answers are asked (`withConfirmation`). Only a dangerous yes is drawn in the danger colour. */
export const ask: Ask = (question) => confirmAction(question.title, question.message, question.yes, question.tone);
