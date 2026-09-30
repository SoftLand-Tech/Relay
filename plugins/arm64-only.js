const { withGradleProperties } = require("expo/config-plugins");

/**
 * Production APK size: strip the native libraries to arm64-v8a ONLY.
 *
 * React Native's gradle build reads `reactNativeArchitectures` (default
 * "armeabi-v7a,arm64-v8a,x86,x86_64") and filters every .so it packages by
 * it. Dropping to the single ABI every phone since ~2016 uses turns the
 * ~136MB universal artifact into a ~40MB APK — the difference the Play
 * Store normally gets for free via AAB splitting, which we can't use
 * (direct APK distribution). Mirrors recipe-meal/mobile/plugins/arm64-only.
 *
 * Scoped to EAS production profiles only (EAS_BUILD_PROFILE) so preview
 * builds and anything running locally stay universal.
 */
module.exports = function arm64OnlyPlugin(config) {
  return withGradleProperties(config, (cfg) => {
    const profile = process.env.EAS_BUILD_PROFILE ?? "";
    if (!profile.startsWith("production")) {
      return cfg;
    }
    const rest = cfg.modResults.filter((item) => item.key !== "reactNativeArchitectures");
    rest.push({ type: "property", key: "reactNativeArchitectures", value: "arm64-v8a" });
    cfg.modResults = rest;
    return cfg;
  });
};
