import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_OUT,
  SIGNED_ENTITLEMENTS,
  buildEnv,
  buildReleaseConfig,
  check,
  detectNotarization,
  diffFuses,
  expectedFuses,
  formatTable,
  hasFailure,
  isIcloudPath,
  notarytoolAuthArgs,
  parseArgs,
  parseCodesignDisplay,
  parseEntitlementKeys,
  parseFuses,
  planRelease,
} from "../scripts/release-lib.mjs";

const base = {
  mac: { target: "dir", identity: "-", hardenedRuntime: true },
  directories: { output: "release" },
};

test("parseArgs defaults and flags", () => {
  assert.deepEqual(parseArgs([]), {
    out: DEFAULT_OUT,
    skipBuild: false,
    adhoc: false,
    noNotarize: false,
    testModes: false,
    help: false,
  });
  assert.equal(parseArgs(["--test-modes"]).testModes, true);
  assert.equal(parseArgs(["--out", "/x/y"]).out, "/x/y");
  assert.equal(parseArgs(["--out=/x/z", "--adhoc"]).adhoc, true);
  assert.throws(() => parseArgs(["--out"]));
  assert.throws(() => parseArgs(["--nope"]));
});

test("iCloud-synced paths are detected", () => {
  assert.equal(isIcloudPath("/Users/me/Desktop/a", "/Users/me"), true);
  assert.equal(isIcloudPath("/Users/me/Desktop", "/Users/me"), true);
  assert.equal(isIcloudPath("/Users/me/Desktop2/a", "/Users/me"), false);
  assert.equal(isIcloudPath("/tmp/murmur-release", "/Users/me"), false);
});

test("plan: no identity means ad-hoc and no notarization, even with Apple variables", () => {
  const plan = planRelease(
    { APPLE_ID: "a", APPLE_APP_SPECIFIC_PASSWORD: "b", APPLE_TEAM_ID: "c" },
    parseArgs([]),
  );
  assert.equal(plan.mode, "adhoc");
  assert.equal(plan.notarize, false);
  assert.deepEqual(plan.errors, []);
});

test("plan: signed without notarization credentials is an error unless --no-notarize", () => {
  assert.equal(
    planRelease({ CSC_NAME: "Developer ID Application: X (T)" }, parseArgs([]))
      .errors.length,
    1,
  );
  const plan = planRelease({ CSC_NAME: "n" }, parseArgs(["--no-notarize"]));
  assert.equal(plan.mode, "signed");
  assert.equal(plan.notarize, false);
  assert.deepEqual(plan.errors, []);
});

test("plan: --adhoc wins over signing variables", () => {
  assert.equal(
    planRelease({ CSC_LINK: "x" }, parseArgs(["--adhoc"])).mode,
    "adhoc",
  );
});

test("notarization credential sets", () => {
  assert.equal(
    detectNotarization({
      APPLE_API_KEY: "k",
      APPLE_API_KEY_ID: "i",
      APPLE_API_ISSUER: "s",
    }),
    "api-key",
  );
  assert.equal(detectNotarization({ APPLE_API_KEY: "k" }), null);
  assert.equal(
    detectNotarization({ APPLE_KEYCHAIN_PROFILE: "p" }),
    "keychain-profile",
  );
  assert.deepEqual(notarytoolAuthArgs({ APPLE_KEYCHAIN_PROFILE: "p" }), [
    "--keychain-profile",
    "p",
  ]);
  assert.equal(notarytoolAuthArgs({}), null);
});

test("release config: ad-hoc keeps identity '-', signed drops it so CSC_* decides", () => {
  const adhoc = buildReleaseConfig(base, planRelease({}, parseArgs([])), "/o");
  assert.equal(adhoc.mac.identity, "-");
  assert.equal(adhoc.mac.notarize, false);
  assert.equal(adhoc.directories.output, "/o");
  assert.deepEqual(
    adhoc.mac.target.map((t: { target: string }) => t.target),
    ["dmg", "zip"],
  );
  const signed = buildReleaseConfig(
    base,
    planRelease({ CSC_NAME: "n", APPLE_KEYCHAIN_PROFILE: "p" }, parseArgs([])),
    "/o",
  );
  assert.equal("identity" in signed.mac, false);
  assert.equal(signed.mac.notarize, true);
  assert.equal(signed.dmg.sign, true);
  assert.equal(base.mac.identity, "-");
  assert.equal(signed.mac.entitlements, SIGNED_ENTITLEMENTS);
  assert.equal(signed.mac.entitlementsInherit, SIGNED_ENTITLEMENTS);
  assert.equal(
    adhoc.mac.entitlements,
    undefined,
    "ad-hoc keeps the package.json file",
  );
});

test("entitlement keys are read from codesign output; test modes are off unless asked", () => {
  assert.deepEqual(
    parseEntitlementKeys(
      "<dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.device.audio-input</key><true/></dict>",
    ),
    ["cs.allow-jit", "device.audio-input"],
  );
  const env = { MURMUR_TEST_MODES: "1", PATH: "/bin" };
  assert.equal(
    "MURMUR_TEST_MODES" in buildEnv(env, parseArgs([])),
    false,
    "an inherited value must not leak into a release build",
  );
  assert.equal(
    buildEnv({ PATH: "/bin" }, parseArgs(["--test-modes"])).MURMUR_TEST_MODES,
    "1",
  );
});

test("parseCodesignDisplay reads ad-hoc and Developer ID output", () => {
  const adhoc = parseCodesignDisplay(
    "Identifier=app.murmur.desktop\nCodeDirectory v=20500 size=1 flags=0x10002(adhoc,runtime) hashes=1\nSignature=adhoc\nTeamIdentifier=not set\n",
  );
  assert.equal(adhoc.adhoc, true);
  assert.equal(adhoc.hardenedRuntime, true);
  assert.equal(adhoc.teamId, null);
  const signed = parseCodesignDisplay(
    "Identifier=app.murmur.desktop\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=1\nAuthority=Developer ID Application: A (TEAM123456)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=TEAM123456\n",
  );
  assert.equal(signed.adhoc, false);
  assert.equal(signed.teamId, "TEAM123456");
  assert.equal(signed.authorities.length, 2);
  assert.equal(
    parseCodesignDisplay("CodeDirectory flags=0x0(none)").hardenedRuntime,
    false,
  );
});

test("fuses are parsed and compared", () => {
  const fuses = parseFuses(
    "Analyzing app: X\n  RunAsNode is Disabled\n  OnlyLoadAppFromAsar is Enabled\n",
  );
  assert.deepEqual(fuses, { RunAsNode: false, OnlyLoadAppFromAsar: true });
  const want = expectedFuses({
    runAsNode: false,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  });
  assert.deepEqual(diffFuses(fuses, want), [
    "EnableCookieEncryption: want on, got missing",
  ]);
  assert.deepEqual(diffFuses({ RunAsNode: true }, { RunAsNode: false }), [
    "RunAsNode: want off, got on",
  ]);
});

test("table lists every check and fails on any FAIL", () => {
  const results = [
    check("a", "PASS", "ok"),
    check("b", "WARN"),
    check("c", "FAIL", "bad"),
  ];
  assert.equal(hasFailure(results), true);
  assert.equal(hasFailure(results.slice(0, 2)), false);
  const table = formatTable(results);
  assert.match(table, /PASS\s+a\s+ok/);
  assert.match(table, /1 pass, 1 fail, 1 warn, 0 skipped/);
});
