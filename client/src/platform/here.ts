import { Platform } from 'react-native';

/** Where the app runs: a browser's page, or a phone. */
export const HERE_PLATFORM: 'web' | 'native' = Platform.OS === 'web' ? 'web' : 'native';

/** What the app calls where it runs, in a sentence: "from this browser". */
export const HERE = HERE_PLATFORM === 'web' ? 'this browser' : 'this phone';

/** What this app is called where it holds a server's ways, in "held by …": the browser and its system, or the phone. */
export function appName(): string {
  if (Platform.OS !== 'web') return Platform.OS === 'ios' ? 'This iPhone' : 'This Android phone';
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const system = /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'a Mac' : /Android/.test(agent) ? 'Android' : /Linux/.test(agent) ? 'Linux' : null;
  return system ? `${browser} on ${system}` : browser;
}
