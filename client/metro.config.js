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

/**
 * No gzip for the development bundle.
 *
 * Expo's dev server gzips bundles on the fly, and on this repository's ~8 MB
 * development bundle that turns a 0.2 s response into ten seconds on every
 * reload (measured on Windows: uncompressed 0.2 s, gzipped 10.3 s). The
 * compression middleware decides when the response starts, from the request's
 * Accept-Encoding, so dropping that header before Metro answers serves the
 * bundle as it is. Over localhost or a home network, the size costs nothing.
 */
const enhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const inner = enhanceMiddleware ? enhanceMiddleware(middleware, server) : middleware;
  return (req, res, next) => {
    if (req.url && /\.(bundle|map)(\?|$)/.test(req.url)) delete req.headers['accept-encoding'];
    return inner(req, res, next);
  };
};

module.exports = config;
