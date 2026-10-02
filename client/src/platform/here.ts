import { Platform } from 'react-native';

/** Where the app runs: a browser's page, or a phone. */
export const HERE_PLATFORM: 'web' | 'native' = Platform.OS === 'web' ? 'web' : 'native';

/** What the app calls where it runs, in a sentence: "from this browser". */
export const HERE = HERE_PLATFORM === 'web' ? 'this browser' : 'this phone';
