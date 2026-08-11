module.exports = function (api) {
  // Metro tells Babel which platform it is bundling for.
  const platform = api.caller((caller) => caller?.platform) ?? 'web';
  const isWeb = platform === 'web';

  process.env.TAMAGUI_TARGET = isWeb ? 'web' : 'native';

  // Cache per platform rather than once globally, so web and native each get
  // their own transform result.
  api.cache.using(() => platform);

  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
    // `@tamagui/babel-plugin` hardcodes `createExtractor({ platform: 'native' })`
    // (see @tamagui/static/src/extractor/extractToNative.ts). Running it over the
    // web bundle applies native-targeted extraction to web code, so scope it to
    // native only. Web optimisation would come from @tamagui/metro-plugin instead.
    plugins: isWeb ? [] : ['@tamagui/babel-plugin'],
  };
};
