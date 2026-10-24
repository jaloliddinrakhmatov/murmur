// The --smoke/--capture/--compare/--latency modes write throwaway profiles and drive real
// windows, so a shipped build ignores them. They run when the app is not packaged, or when the
// build was made with MURMUR_TEST_MODES=1 (electron-vite replaces __MURMUR_TEST_MODES__ at
// build time; it is false in production builds otherwise).
declare const __MURMUR_TEST_MODES__: boolean | undefined;

export function builtWithTestModes(): boolean {
  return typeof __MURMUR_TEST_MODES__ !== "undefined" && __MURMUR_TEST_MODES__;
}

export function testModesAllowed(
  isPackaged: boolean,
  builtWith: boolean = builtWithTestModes(),
): boolean {
  return !isPackaged || builtWith;
}

/** The test-mode flags actually in effect for these arguments (all false when not allowed). */
export function testModeFlags(
  argv: string[],
  allowed: boolean,
): { smoke: boolean; capture: boolean; compare: boolean; latency: boolean } {
  const has = (prefix: string, exact = false) =>
    allowed && argv.some((a) => (exact ? a === prefix : a.startsWith(prefix)));
  return {
    smoke: has("--smoke", true),
    capture: has("--capture"),
    compare: has("--compare"),
    latency: has("--latency"),
  };
}
