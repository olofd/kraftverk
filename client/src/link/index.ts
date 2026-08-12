import { Platform } from 'react-native';

import type { TransportKind } from '@kraftverk/protocol';

import { NativeBleTransport, NATIVE_BLE_SETUP, nativeBleInstalled } from './nativeBle';
import {
  ChooserCancelled,
  WebBluetoothTransport,
  webBluetoothAvailable,
  webBluetoothBlockedReason,
  webBluetoothUnusableReason,
} from './webBle';

export { ChooserCancelled, NativeBleTransport, WebBluetoothTransport };

/**
 * Connecting to the station from the app itself, with no server in between.
 *
 * The browser and the phone use completely different Bluetooth APIs, so which
 * transport you get depends on where the app is running — but both feed the
 * same `StationClient` from `@kraftverk/protocol`, which is also what the
 * server runs. One protocol implementation, three ways to reach the hardware.
 */
export type DirectTransport = WebBluetoothTransport | NativeBleTransport;

export type DirectSupport = {
  supported: boolean;
  kind: TransportKind;
  /** Why it is unavailable here, in words worth showing a user. */
  reason: string | null;
  /** How the link is described in the UI. */
  label: string;
};

export function directSupport(): DirectSupport {
  if (Platform.OS === 'web') {
    return {
      supported: webBluetoothAvailable(),
      kind: 'direct-web-ble',
      reason: webBluetoothBlockedReason(),
      label: 'Web Bluetooth',
    };
  }

  return {
    supported: nativeBleInstalled(),
    kind: 'direct-native-ble',
    reason: nativeBleInstalled() ? null : NATIVE_BLE_SETUP,
    label: 'Bluetooth LE',
  };
}

/**
 * A second, asynchronous look at whether this really works here.
 *
 * `directSupport()` can only check what exists synchronously, and a browser
 * that has Web Bluetooth switched off still exposes the whole API — it refuses
 * at the chooser. Asking the browser directly means the screen can say so
 * before someone taps a button that was never going to work.
 */
export async function probeDirectSupport(): Promise<string | null> {
  return Platform.OS === 'web' ? webBluetoothUnusableReason() : null;
}

export function createDirectTransport(): DirectTransport {
  return Platform.OS === 'web' ? new WebBluetoothTransport() : new NativeBleTransport();
}
