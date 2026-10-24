import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "../..");

type Json = Record<string, any>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));

const desktopPackage = readJson(join(desktopDir, "package.json"));
const build: Json = desktopPackage.build;
const mac: Json = build.mac;

function subdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => join(dir, entry.name));
}

function workspacePackageFiles(): string[] {
  const dirs = [
    repoRoot,
    desktopDir,
    join(repoRoot, "native"),
    ...subdirectories(join(repoRoot, "packages")),
    ...subdirectories(join(repoRoot, "prototypes")),
  ];
  return dirs
    .map((dir) => join(dir, "package.json"))
    .filter((file) => existsSync(file));
}

const entitlementsPath = resolve(desktopDir, mac.entitlements);
const keysOf = (file: string): string[] => {
  const xml = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  return [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
};
const entitlementKeys = (): string[] => keysOf(entitlementsPath);
// Every entitlements plist under build/ (the dev/ad-hoc one and the Developer ID one).
const buildDir = join(desktopDir, "build");
const entitlementFiles = readdirSync(buildDir)
  .filter((name) => /^entitlements.*\.plist$/.test(name))
  .map((name) => join(buildDir, name));
const LIBRARY_VALIDATION = "com.apple.security.cs.disable-library-validation";

// Every entitlement the app is allowed to carry. Adding one must be a deliberate edit here;
// removing one (for example after a security review) keeps this test green.
const ALLOWED_ENTITLEMENTS = new Set([
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.device.audio-input",
  // Settings → Connectors → Calendar reads events through EventKit (hardened runtime requires it).
  "com.apple.security.personal-information.calendars",
]);

test("app identity: appId and productName are fixed", () => {
  assert.equal(build.appId, "app.murmur.desktop");
  assert.equal(build.productName, "Murmur");
});

test("no workspace package.json sets a top-level productName", () => {
  const files = workspacePackageFiles();
  assert.ok(
    files.length >= 5,
    "expected the root, desktop, native and package manifests",
  );
  for (const file of files) {
    assert.equal(
      "productName" in readJson(file),
      false,
      `${file} must not set productName (it renames the dev identity and data folder)`,
    );
  }
});

test("hardened runtime is on and the entitlement files exist", () => {
  assert.equal(mac.hardenedRuntime, true);
  for (const key of ["entitlements", "entitlementsInherit"]) {
    assert.equal(typeof mac[key], "string", `mac.${key} must be set`);
    assert.ok(
      existsSync(resolve(desktopDir, mac[key])),
      `mac.${key} points to a missing file`,
    );
  }
});

test("Info.plist usage descriptions explain dictation and Notetaker", () => {
  const info: Json = mac.extendInfo ?? {};
  const mic = info.NSMicrophoneUsageDescription;
  const audio = info.NSAudioCaptureUsageDescription;
  assert.equal(typeof mic, "string");
  assert.ok(mic.trim().length > 0);
  assert.match(mic, /dictat/i);
  assert.equal(typeof audio, "string");
  assert.ok(audio.trim().length > 0);
  assert.match(audio, /meeting|notetaker/i);
});

test("Electron fuses lock down node, inspector and asar loading", () => {
  const fuses: Json = build.electronFuses;
  assert.equal(fuses.runAsNode, false);
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(fuses.onlyLoadAppFromAsar, true);
});

test("native addons are unpacked from the asar and build sources are not packaged", () => {
  assert.ok(
    (build.asarUnpack as string[]).some((pattern) => pattern.endsWith(".node")),
    "asarUnpack must cover .node files",
  );
  const files = build.files as string[];
  const exclusions = files
    .filter((pattern) => pattern.startsWith("!"))
    .join("\n");
  assert.match(exclusions, /\btarget\b/, "Rust target/ must be excluded");
  assert.match(exclusions, /\bcrates\b/, "Rust crates/ must be excluded");
});

test("every entitlements plist includes audio input and nothing outside the allow-list", () => {
  assert.ok(
    entitlementFiles.length >= 2,
    "expected the ad-hoc and signed plists",
  );
  for (const file of entitlementFiles) {
    const keys = keysOf(file);
    assert.ok(
      keys.includes("com.apple.security.device.audio-input"),
      `${file} lacks audio input`,
    );
    assert.equal(new Set(keys).size, keys.length, `${file}: duplicate keys`);
    const unexpected = keys.filter((key) => !ALLOWED_ENTITLEMENTS.has(key));
    assert.deepEqual(
      unexpected,
      [],
      `${file}: new entitlements need a deliberate allow-list update`,
    );
  }
});

test("entitlements never include debugging, camera, automation or sandbox-file keys", () => {
  const forbidden = [
    /get-task-allow/,
    /device\.camera/,
    /automation\.apple-events/,
    /disable-executable-page-protection/,
    /app-sandbox/,
    /files\.(all|user-selected|downloads)/,
    /temporary-exception/,
  ];
  for (const file of entitlementFiles) {
    for (const key of keysOf(file)) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(
          key,
          pattern,
          `${file}: ${key} is not appropriate for this app`,
        );
      }
    }
  }
});

test("Developer ID entitlements keep library validation on; only the ad-hoc plist disables it", () => {
  const signedFile = join(buildDir, "entitlements.mac.signed.plist");
  assert.ok(existsSync(signedFile));
  assert.equal(keysOf(signedFile).includes(LIBRARY_VALIDATION), false);
  assert.ok(
    entitlementKeys().includes(LIBRARY_VALIDATION),
    "the ad-hoc build can't load its addon without it",
  );
  const others = entitlementFiles.filter(
    (f) => f !== entitlementsPath && keysOf(f).includes(LIBRARY_VALIDATION),
  );
  assert.deepEqual(others, []);
});

test("no signing secrets are hard-coded in any package.json", () => {
  const secretNames = [
    "CSC_KEY_PASSWORD",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "appleIdPassword",
  ];
  const isReference = (value: unknown) =>
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "string" && /^\$|\$\{|^env\./.test(value));

  const walk = (node: unknown, file: string) => {
    if (typeof node === "string") {
      assert.doesNotMatch(node, /\.p12\b/i, `${file}: certificate file path`);
      for (const name of secretNames) {
        assert.doesNotMatch(
          node,
          new RegExp(`${name}\\s*=\\s*[^$\\s"']`),
          `${file}: literal ${name} assignment`,
        );
      }
    } else if (Array.isArray(node)) {
      node.forEach((item) => walk(item, file));
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (secretNames.includes(key) || /password/i.test(key)) {
          assert.ok(
            isReference(value),
            `${file}: ${key} must not hold a literal value`,
          );
        }
        walk(value, file);
      }
    }
  };
  for (const file of workspacePackageFiles()) walk(readJson(file), file);
});

test("private screenshots are git-ignored and cannot be packaged", () => {
  const ignored = readFileSync(join(repoRoot, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim());
  assert.ok(
    ignored.some((line) => line === "screenshots/" || line === "/screenshots/"),
    "screenshots/ must be listed in .gitignore",
  );
  for (const pattern of build.files as string[]) {
    if (pattern.startsWith("!")) continue;
    assert.doesNotMatch(
      pattern,
      /screenshots/i,
      `files pattern ${pattern} could ship screenshots`,
    );
    assert.ok(
      !pattern.startsWith(".."),
      `files pattern ${pattern} escapes the app directory`,
    );
  }
  assert.equal(
    existsSync(join(desktopDir, "screenshots")),
    false,
    "apps/desktop/screenshots would sit inside the packaged app directory",
  );
});
