import Constants from 'expo-constants';
import { Platform } from 'react-native';

/*
  Where a kraftverk server would be, if one runs beside this app
  (docs/PLAN-SHARED-CORE.md, phase 6): the app's to work out, from where it
  runs — api-client is handed an address, and never finds one.
*/

/** The port a kraftverk server's API listens on, unless its owner moved it. */
export const API_PORT = Number(process.env.EXPO_PUBLIC_API_PORT ?? 3333);

/**
 * Where the API would live, beside this app.
 *
 * Web and the iOS Simulator can both reach `localhost`, but Expo Go on a
 * physical iPhone cannot — there `localhost` is the phone itself. Expo hands
 * over the dev machine's address in `hostUri`, so that host is used with the
 * API's port.
 */
function besideThisApp(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  /*
    `same-origin`: the app is served by the same host that proxies `/api` to a
    server — the web container. Resolved at runtime rather than baked in, so
    one build works at a LAN address and at a public name alike, and over
    HTTPS without a mixed-content refusal.
  */
  if (explicit === 'same-origin' && typeof window !== 'undefined' && window.location?.origin) return `${window.location.origin}/api`;
  if (explicit && explicit !== 'same-origin') return explicit.replace(/\/$/, '');
  if (Platform.OS === 'web') {
    // Served from the machine that runs the dev server, so its host is right whether that is localhost or an address on the network.
    const host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'localhost';
    return `http://${host}:${API_PORT}/api`;
  }
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri?.split('/')[0]?.split(':')[0];
  return `http://${host ?? 'localhost'}:${API_PORT}/api`;
}

/**
 * Where a server would be, if one is running beside this app: a suggestion,
 * not a fact. The app is used with no server at all, so this is the address
 * tried at the first run, and offered when someone adds one.
 */
export const SERVER_BESIDE_THIS_APP = besideThisApp();
