// Builds, packages and statically verifies a Murmur release (DMG + ZIP, arm64).
//
//   npm run release -w apps/desktop [-- --out <dir>] [--adhoc] [--no-notarize] [--skip-build] [--test-modes]
//
// Signing and notarization come from the environment only (see --help). Without a Developer ID
// (CSC_LINK / CSC_NAME) the build is ad-hoc signed and never submitted to Apple. The packaged
// app is never launched here: each ad-hoc rebuild has a new signature and macOS would block it
// on a Keychain prompt.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_VALIDATION_KEY,
  buildEnv,
  buildReleaseConfig,
  check,
  diffFuses,
  expectedArtifactNames,
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
} from "./release-lib.mjs";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));

const HELP = `Usage: npm run release -w apps/desktop -- [options]

  --out <dir>      Output directory, outside iCloud-synced folders (default /tmp/murmur-release)
  --adhoc          Ignore signing variables and build an ad-hoc signed dry run
  --no-notarize    Sign but do not notarize (rejected unless you ask for it)
  --skip-build     Reuse apps/desktop/out from an earlier "npm run build"
  --test-modes     Build with MURMUR_TEST_MODES=1 so --smoke and the other test modes are compiled
                   in (default off: a release build refuses them). Never ship such a build.

Entitlements: Developer ID builds use build/entitlements.mac.signed.plist (library validation
stays on); ad-hoc builds use build/entitlements.mac.plist (needs disable-library-validation).

Signing (Developer ID Application certificate):
  CSC_NAME                       certificate name in your keychain, or
  CSC_LINK, CSC_KEY_PASSWORD     a .p12 file or base64 of it, and its password

Notarization (one of):
  APPLE_API_KEY (path to .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER
  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
  APPLE_KEYCHAIN_PROFILE (and optionally APPLE_KEYCHAIN): a "notarytool store-credentials" profile
`;

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function runInherit(cmd, args, env) {
  const result = spawnSync(cmd, args, {
    cwd: projectDir,
    stdio: "inherit",
    env,
  });
  if (result.status !== 0)
    throw new Error(`${cmd} ${args[0] ?? ""} failed (exit ${result.status})`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cleanEnv(plan, options) {
  const env = buildEnv(process.env, options);
  delete env.ELECTRON_RUN_AS_NODE;
  if (plan.mode === "adhoc") {
    for (const key of Object.keys(env))
      if (key.startsWith("CSC_") || key.startsWith("APPLE_")) delete env[key];
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }
  return env;
}

function packageApp(options, plan, out) {
  if (!options.skipBuild)
    runInherit("npm", ["run", "build"], cleanEnv(plan, options));
  const version = pkg.version;
  const names = expectedArtifactNames(version);
  // Remove only what a previous run produced, so stale files are never verified.
  for (const path of [
    join(out, "mac-arm64"),
    join(out, names.dmg),
    join(out, names.zip),
    join(out, "builder-debug.yml"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  const configPath = join(out, "electron-builder.release.json");
  writeFileSync(
    configPath,
    JSON.stringify(buildReleaseConfig(pkg.build, plan, out), null, 2),
  );
  runInherit(
    "npx",
    ["electron-builder", "--mac", "--config", configPath],
    cleanEnv(plan, options),
  );
  return names;
}

// electron-builder notarizes and staples the .app; the DMG container is notarized here.
function notarizeDmg(dmgPath) {
  const auth = notarytoolAuthArgs(process.env);
  if (!auth) throw new Error("No notarization credentials for the DMG");
  runInherit(
    "xcrun",
    ["notarytool", "submit", dmgPath, "--wait", ...auth],
    process.env,
  );
  runInherit("xcrun", ["stapler", "staple", dmgPath], process.env);
}

function plistJson(plistPath) {
  const r = run("plutil", ["-convert", "json", "-o", "-", plistPath]);
  return r.ok ? JSON.parse(r.stdout) : null;
}

function findFile(root, name) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}

function lastLine(text) {
  return text.trim().split("\n").filter(Boolean).pop() ?? "";
}

function verify(out, plan, names, options) {
  const results = [];
  const signed = plan.mode === "signed";
  const appPath = join(out, "mac-arm64", `${pkg.build.productName}.app`);
  const dmgPath = join(out, names.dmg);
  const zipPath = join(out, names.zip);
  const expectNote = signed ? "" : " (expected for an ad-hoc build)";

  for (const [label, path] of [
    ["App bundle", appPath],
    ["DMG", dmgPath],
    ["ZIP", zipPath],
  ]) {
    const exists = existsSync(path);
    results.push(
      check(
        `${label} exists`,
        exists ? "PASS" : "FAIL",
        exists ? path : `missing: ${path}`,
      ),
    );
  }
  if (!existsSync(appPath)) return results;

  const infoPlist = plistJson(join(appPath, "Contents", "Info.plist"));
  if (!infoPlist) {
    results.push(check("Info.plist readable", "FAIL"));
  } else {
    results.push(
      check(
        "Bundle ID",
        infoPlist.CFBundleIdentifier === pkg.build.appId ? "PASS" : "FAIL",
        String(infoPlist.CFBundleIdentifier),
      ),
    );
    results.push(
      check(
        "Version",
        infoPlist.CFBundleShortVersionString === pkg.version ? "PASS" : "FAIL",
        `${infoPlist.CFBundleShortVersionString} (package.json ${pkg.version})`,
      ),
    );
    for (const key of [
      "NSMicrophoneUsageDescription",
      "NSAudioCaptureUsageDescription",
    ]) {
      const text = infoPlist[key];
      results.push(
        check(
          key,
          typeof text === "string" && text.length > 0 ? "PASS" : "FAIL",
          text ? `"${text.slice(0, 40)}..."` : "missing",
        ),
      );
    }
  }
  for (const path of [dmgPath, zipPath]) {
    if (existsSync(path) && !path.includes(`-${pkg.version}-`))
      results.push(check("Artifact name has version", "FAIL", path));
  }

  const exe = join(appPath, "Contents", "MacOS", pkg.build.productName);
  const archs = run("lipo", ["-archs", exe]);
  results.push(
    check(
      "Architecture",
      archs.ok && archs.stdout.trim() === "arm64" ? "PASS" : "FAIL",
      archs.stdout.trim() || archs.stderr.trim(),
    ),
  );

  const verifyApp = run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  results.push(
    check(
      "codesign --verify --deep --strict",
      verifyApp.ok ? "PASS" : "FAIL",
      verifyApp.ok
        ? "valid on disk, satisfies Designated Requirement"
        : lastLine(verifyApp.stderr),
    ),
  );

  const display = parseCodesignDisplay(
    run("codesign", ["-dvvv", appPath]).stderr,
  );
  results.push(
    check(
      "Identifier",
      display.identifier === pkg.build.appId ? "PASS" : "FAIL",
      String(display.identifier),
    ),
  );
  results.push(
    check(
      "Hardened runtime flag",
      display.hardenedRuntime ? "PASS" : "FAIL",
      display.flags.join(",") || "no flags",
    ),
  );
  if (signed) {
    const devId = display.authorities.find((a) =>
      a.startsWith("Developer ID Application"),
    );
    results.push(
      check(
        "Signing authority",
        devId ? "PASS" : "FAIL",
        display.authorities.join(" > ") || "none",
      ),
    );
    results.push(
      check(
        "Team ID",
        display.teamId ? "PASS" : "FAIL",
        display.teamId ?? "not set",
      ),
    );
  } else {
    results.push(
      check(
        "Signing authority",
        display.adhoc ? "WARN" : "FAIL",
        display.adhoc
          ? `ad-hoc, no Developer ID${expectNote}`
          : display.authorities.join(" > ") || "unknown",
      ),
    );
    results.push(
      check("Team ID", "WARN", `${display.teamId ?? "not set"}${expectNote}`),
    );
  }

  const entitlementsOf = (path) =>
    parseEntitlementKeys(
      run("codesign", ["-d", "--entitlements", ":-", path]).stdout,
    );
  const keys = entitlementsOf(appPath);
  results.push(
    check(
      "Entitlements (main)",
      keys.length > 0 ? "PASS" : "FAIL",
      keys.join(", ") || "none",
    ),
  );
  const hasLv = keys.includes(LIBRARY_VALIDATION_KEY);
  results.push(
    check(
      "Library validation",
      signed ? (hasLv ? "FAIL" : "PASS") : hasLv ? "WARN" : "FAIL",
      signed
        ? hasLv
          ? "disable-library-validation is present in a Developer ID build"
          : "on (no disable-library-validation)"
        : hasLv
          ? `disabled${expectNote}: ad-hoc code has no Team ID`
          : "on, but the ad-hoc addon would not load",
    ),
  );

  // One Team ID across the main binary, every helper and framework, and the addon.
  const frameworks = join(appPath, "Contents", "Frameworks");
  const helpers = existsSync(frameworks)
    ? readdirSync(frameworks)
        .filter((n) => n.endsWith(".app"))
        .sort()
    : [];
  for (const name of helpers) {
    const path = join(frameworks, name);
    const info = parseCodesignDisplay(run("codesign", ["-dvvv", path]).stderr);
    const helperKeys = entitlementsOf(path);
    const sameTeam = signed ? info.teamId === display.teamId : info.adhoc;
    results.push(
      check(
        `Helper ${name.replace(/\.app$/, "").replace(/^Murmur /, "")}`,
        sameTeam && (!signed || !helperKeys.includes(LIBRARY_VALIDATION_KEY))
          ? "PASS"
          : "FAIL",
        `${signed ? `team ${info.teamId ?? "none"}` : "ad-hoc"}; ${helperKeys.join(", ") || "no entitlements"}`,
      ),
    );
  }
  const electronFramework = join(frameworks, "Electron Framework.framework");
  if (existsSync(electronFramework)) {
    const info = parseCodesignDisplay(
      run("codesign", ["-dvvv", electronFramework]).stderr,
    );
    results.push(
      check(
        "Electron Framework signature",
        signed ? (info.teamId === display.teamId ? "PASS" : "FAIL") : "PASS",
        signed
          ? `team ${info.teamId ?? "none"}`
          : info.adhoc
            ? "ad-hoc"
            : "signed",
      ),
    );
  }

  const spctl = run("spctl", ["--assess", "--type", "execute", "-vv", appPath]);
  const spctlText = (spctl.stderr + spctl.stdout).trim().replace(/\n/g, "; ");
  results.push(
    check(
      "spctl --assess (Gatekeeper)",
      spctl.ok ? "PASS" : signed ? "FAIL" : "WARN",
      `${spctlText}${spctl.ok ? "" : expectNote}`,
    ),
  );

  const stapledApp = run("xcrun", ["stapler", "validate", appPath]);
  const stapledDmg = existsSync(dmgPath)
    ? run("xcrun", ["stapler", "validate", dmgPath])
    : null;
  if (plan.notarize) {
    results.push(
      check(
        "stapler validate (app)",
        stapledApp.ok ? "PASS" : "FAIL",
        lastLine(stapledApp.stdout + stapledApp.stderr),
      ),
    );
    results.push(
      check(
        "stapler validate (DMG)",
        stapledDmg?.ok ? "PASS" : "FAIL",
        lastLine((stapledDmg?.stdout ?? "") + (stapledDmg?.stderr ?? "")),
      ),
    );
  } else {
    results.push(
      check("stapler validate", "SKIP", "not notarized in this run"),
    );
  }

  const fuses = run(
    join(projectDir, "..", "..", "node_modules", ".bin", "electron-fuses"),
    ["read", "--app", appPath],
    { env: cleanEnv(plan, options) },
  );
  const fuseDiff = fuses.ok
    ? diffFuses(
        parseFuses(fuses.stdout),
        expectedFuses(pkg.build.electronFuses),
      )
    : ["could not read fuses"];
  results.push(
    check(
      "Electron fuses",
      fuseDiff.length === 0 ? "PASS" : "FAIL",
      fuseDiff.length === 0
        ? Object.keys(pkg.build.electronFuses).join(", ")
        : fuseDiff.join("; "),
    ),
  );

  const unpacked = join(appPath, "Contents", "Resources", "app.asar.unpacked");
  const addon = findFile(unpacked, "murmur_native.node");
  if (!addon) {
    results.push(
      check(
        "murmur_native.node unpacked",
        "FAIL",
        "not found under app.asar.unpacked",
      ),
    );
  } else {
    results.push(
      check(
        "murmur_native.node unpacked",
        "PASS",
        addon.slice(appPath.length + 1),
      ),
    );
    const addonVerify = run("codesign", ["--verify", "--strict", addon]);
    const addonInfo = parseCodesignDisplay(
      run("codesign", ["-dvvv", addon]).stderr,
    );
    const addonSigned = signed
      ? addonInfo.authorities.some((a) =>
          a.startsWith("Developer ID Application"),
        ) && addonInfo.teamId === display.teamId
      : addonInfo.adhoc;
    const addonKeys = entitlementsOf(addon);
    results.push(
      check(
        "murmur_native.node entitlements",
        "PASS",
        addonKeys.join(", ") || "none (a library carries none)",
      ),
    );
    results.push(
      check(
        "murmur_native.node signed",
        addonVerify.ok && addonSigned ? "PASS" : "FAIL",
        addonVerify.ok
          ? signed
            ? `team ${addonInfo.teamId}`
            : "ad-hoc"
          : lastLine(addonVerify.stderr),
      ),
    );
  }

  if (existsSync(dmgPath)) {
    const dmg = run("hdiutil", ["verify", dmgPath]);
    results.push(
      check(
        "DMG integrity (hdiutil verify)",
        dmg.ok ? "PASS" : "FAIL",
        lastLine(dmg.stdout + dmg.stderr),
      ),
    );
    if (signed) {
      const dmgSig = run("codesign", ["--verify", "--strict", dmgPath]);
      results.push(
        check(
          "DMG signature",
          dmgSig.ok ? "PASS" : "FAIL",
          dmgSig.ok ? "valid" : lastLine(dmgSig.stderr),
        ),
      );
    }
  }
  if (existsSync(zipPath)) {
    const listing = run("unzip", ["-l", zipPath]);
    const hasApp =
      listing.ok &&
      listing.stdout.includes(
        `${pkg.build.productName}.app/Contents/Info.plist`,
      );
    results.push(
      check(
        "ZIP contains the app",
        hasApp ? "PASS" : "FAIL",
        `${(statSync(zipPath).size / 1048576).toFixed(0)} MB`,
      ),
    );
  }
  return results;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const out = resolve(options.out);
  if (isIcloudPath(out))
    throw new Error(
      `${out} is in an iCloud-synced folder; codesign fails there. Use --out with another path.`,
    );
  const plan = planRelease(process.env, options);
  if (plan.errors.length > 0) throw new Error(plan.errors.join("\n"));
  mkdirSync(out, { recursive: true });

  console.log(
    plan.mode === "signed"
      ? `Mode: Developer ID signing (from ${plan.signingSource})${plan.notarize ? `, notarization via ${plan.notarizeMethod}` : ", NOT notarized"}`
      : "Mode: ad-hoc dry run (no Developer ID, nothing is sent to Apple)",
  );
  console.log(`Output: ${out}`);
  console.log(
    `Test modes: ${options.testModes ? "ON (--test-modes)" : "off"}; entitlements: ${plan.mode === "signed" ? "signed (library validation on)" : "ad-hoc (library validation off)"}`,
  );

  const names = packageApp(options, plan, out);
  const dmgPath = join(out, names.dmg);
  if (plan.notarize) notarizeDmg(dmgPath);

  const results = verify(out, plan, names, options);
  results.push(
    check(
      "Test modes (MURMUR_TEST_MODES)",
      options.skipBuild ? "SKIP" : options.testModes ? "WARN" : "PASS",
      options.skipBuild
        ? "--skip-build: reusing an earlier build, unknown"
        : options.testModes
          ? "ON: --smoke and the other test modes are compiled in; do not ship"
          : "off (default): a release build refuses test modes",
    ),
  );
  console.log(`\n${formatTable(results)}\n`);
  for (const path of [dmgPath, join(out, names.zip)]) {
    if (existsSync(path)) console.log(`SHA-256  ${sha256(path)}  ${path}`);
  }
  if (plan.mode === "adhoc")
    console.log(
      "\nAd-hoc build: for checking the pipeline only. Do not distribute it.",
    );
  return hasFailure(results) ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`release: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
}
