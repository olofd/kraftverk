const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro, taught about the monorepo.
 *
 * The app imports `@kraftverk/protocol` straight from source — it is a
 * workspace package with no build step — so Metro has to watch outside
 * `client/` and look for modules in the root `node_modules` as well as its own.
 * Without this the bundler resolves the symlink and then refuses to leave the
 * project root.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

/**
 * Optional native modules.
 *
 * Direct Bluetooth from a phone needs `react-native-ble-plx`, which is a native
 * module: it cannot run in Expo Go, and most people running this app will not
 * have installed it. Rather than make every build depend on it, resolve it to
 * an empty module when it is absent — and always on web, which uses the Web
 * Bluetooth API instead and would otherwise pull a native library into the
 * browser bundle.
 *
 * `client/src/link/nativeBle.ts` checks at runtime and explains what to install.
 */
const OPTIONAL_NATIVE_MODULES = new Set(['react-native-ble-plx']);

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;

  if (OPTIONAL_NATIVE_MODULES.has(moduleName)) {
    if (platform === 'web') return { type: 'empty' };
    try {
      return resolve(context, moduleName, platform);
    } catch {
      return { type: 'empty' };
    }
  }

  return resolve(context, moduleName, platform);
};

module.exports = config;
