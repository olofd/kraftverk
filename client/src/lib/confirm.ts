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
