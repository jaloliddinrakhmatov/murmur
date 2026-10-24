// Pure helpers for scripts/release.mjs: argument parsing, signing and notarization planning,
// electron-builder config overrides, parsers for codesign and electron-fuses output, and the
// PASS/FAIL table. No process spawning and no file access here, so node:test can import it.
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export const DEFAULT_OUT = "/tmp/murmur-release";

// Developer ID builds keep library validation on; ad-hoc builds (no Team ID) need the exception.
export const SIGNED_ENTITLEMENTS = "build/entitlements.mac.signed.plist";

const STATUS_WIDTH = 6;

export function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    skipBuild: false,
    adhoc: false,
    noNotarize: false,
    testModes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--out needs a directory");
      options.out = value;
      i += 1;
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
      if (!options.out) throw new Error("--out needs a directory");
    } else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--adhoc") options.adhoc = true;
    else if (arg === "--no-notarize") options.noNotarize = true;
    else if (arg === "--test-modes") options.testModes = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// codesign fails on files that a File Provider (iCloud) adds Finder metadata to.
export function isIcloudPath(path, home = homedir()) {
  const full = resolve(path);
  const synced = [
    resolve(home, "Desktop"),
    resolve(home, "Documents"),
    resolve(home, "Library", "Mobile Documents"),
  ];
  return synced.some((dir) => full === dir || full.startsWith(dir + sep));
}

export function detectSigning(env) {
  if (env.CSC_LINK) return { signed: true, source: "CSC_LINK" };
  if (env.CSC_NAME) return { signed: true, source: "CSC_NAME" };
  return { signed: false, source: null };
}

// The three credential sets electron-builder's @electron/notarize integration accepts.
export function detectNotarization(env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    return "api-key";
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
    return "apple-id";
  if (env.APPLE_KEYCHAIN_PROFILE) return "keychain-profile";
  return null;
}

export function planRelease(env, options) {
  const errors = [];
  const detected = detectSigning(env);
  const signed = detected.signed && !options.adhoc;
  const method = detectNotarization(env);
  let notarize = false;
  if (signed && !options.noNotarize) {
    if (method) notarize = true;
    else {
      errors.push(
        "Signing is configured but no notarization credentials are set. Set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER (or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE), or pass --no-notarize.",
      );
    }
  }
  return {
    mode: signed ? "signed" : "adhoc",
    signingSource: signed ? detected.source : null,
    notarize,
    notarizeMethod: notarize ? method : null,
    errors,
  };
}

// Targets, signing identity and notarization are the only things the release overrides; every
// other setting (entitlements, fuses, files, Info.plist text) stays as in package.json.
export function buildReleaseConfig(base, plan, out) {
  const mac = {
    ...base.mac,
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    notarize: plan.notarize,
  };
  if (plan.mode === "signed") {
    delete mac.identity;
    mac.entitlements = SIGNED_ENTITLEMENTS;
    mac.entitlementsInherit = SIGNED_ENTITLEMENTS;
  } else mac.identity = "-";
  return {
    ...base,
    directories: { ...base.directories, output: out },
    mac,
    dmg: { sign: plan.mode === "signed", title: "${productName} ${version}" },
  };
}

export function notarytoolAuthArgs(env) {
  switch (detectNotarization(env)) {
    case "api-key":
      return [
        "--key",
        env.APPLE_API_KEY,
        "--key-id",
        env.APPLE_API_KEY_ID,
        "--issuer",
        env.APPLE_API_ISSUER,
      ];
    case "apple-id":
      return [
        "--apple-id",
        env.APPLE_ID,
        "--password",
        env.APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id",
        env.APPLE_TEAM_ID,
      ];
    case "keychain-profile":
      return [
        "--keychain-profile",
        env.APPLE_KEYCHAIN_PROFILE,
        ...(env.APPLE_KEYCHAIN ? ["--keychain", env.APPLE_KEYCHAIN] : []),
      ];
    default:
      return null;
  }
}

// `codesign -d --entitlements :-` prints an XML plist; short names drop the common prefix.
export function parseEntitlementKeys(text) {
  return [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) =>
    m[1].replace("com.apple.security.", ""),
  );
}

export const LIBRARY_VALIDATION_KEY = "cs.disable-library-validation";

// Environment for the build step: test modes (--smoke etc.) are compiled in only on request.
export function buildEnv(env, options) {
  const out = { ...env };
  if (options.testModes) out.MURMUR_TEST_MODES = "1";
  else delete out.MURMUR_TEST_MODES;
  return out;
}

export function expectedArtifactNames(version) {
  return {
    dmg: `Murmur-${version}-arm64.dmg`,
    zip: `Murmur-${version}-arm64.zip`,
  };
}

// `codesign -dvvv` prints to stderr as Key=Value lines.
export function parseCodesignDisplay(text) {
  const lines = text.split("\n");
  const value = (key) =>
    lines
      .find((l) => l.startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim() ?? null;
  const flagsLine = lines.find((l) => l.startsWith("CodeDirectory "));
  const flagsMatch = flagsLine?.match(/flags=0x[0-9a-f]+\(([^)]*)\)/);
  const flags = flagsMatch
    ? flagsMatch[1]
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
  const signature = value("Signature");
  const team = value("TeamIdentifier");
  return {
    identifier: value("Identifier"),
    authorities: lines
      .filter((l) => l.startsWith("Authority="))
      .map((l) => l.slice("Authority=".length).trim()),
    teamId: team === "not set" ? null : team,
    adhoc: signature === "adhoc",
    hardenedRuntime: flags.includes("runtime"),
    flags,
  };
}

// `electron-fuses read` prints "  Name is Enabled|Disabled".
export function parseFuses(text) {
  const fuses = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s+(\w+) is (Enabled|Disabled)\s*$/);
    if (m) fuses[m[1]] = m[2] === "Enabled";
  }
  return fuses;
}

// electronFuses in package.json uses camelCase keys; the CLI prints PascalCase names.
export function expectedFuses(electronFuses) {
  return Object.fromEntries(
    Object.entries(electronFuses).map(([k, v]) => [
      k[0].toUpperCase() + k.slice(1),
      v,
    ]),
  );
}

export function diffFuses(actual, expected) {
  return Object.entries(expected)
    .filter(([name, want]) => actual[name] !== want)
    .map(
      ([name, want]) =>
        `${name}: want ${want ? "on" : "off"}, got ${actual[name] === undefined ? "missing" : actual[name] ? "on" : "off"}`,
    );
}

export function check(name, status, detail = "") {
  return { name, status, detail };
}

export function hasFailure(results) {
  return results.some((r) => r.status === "FAIL");
}

export function formatTable(results) {
  const nameWidth = Math.max(5, ...results.map((r) => r.name.length));
  const rows = results.map((r) =>
    `${r.status.padEnd(STATUS_WIDTH)} ${r.name.padEnd(nameWidth)}  ${r.detail}`.trimEnd(),
  );
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = `${count("PASS")} pass, ${count("FAIL")} fail, ${count("WARN")} warn, ${count("SKIP")} skipped`;
  return [
    `${"STATUS".padEnd(STATUS_WIDTH)} ${"CHECK".padEnd(nameWidth)}  DETAIL`,
    ...rows,
    "",
    summary,
  ].join("\n");
}
