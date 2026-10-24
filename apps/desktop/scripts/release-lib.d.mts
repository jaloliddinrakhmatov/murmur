export const DEFAULT_OUT: string;
export const SIGNED_ENTITLEMENTS: string;
export const LIBRARY_VALIDATION_KEY: string;
export type Env = Record<string, string | undefined>;
export interface ReleaseOptions {
  out: string;
  skipBuild: boolean;
  adhoc: boolean;
  noNotarize: boolean;
  testModes: boolean;
  help: boolean;
}
export interface ReleasePlan {
  mode: "adhoc" | "signed";
  signingSource: string | null;
  notarize: boolean;
  notarizeMethod: string | null;
  errors: string[];
}
export interface CodesignInfo {
  identifier: string | null;
  authorities: string[];
  teamId: string | null;
  adhoc: boolean;
  hardenedRuntime: boolean;
  flags: string[];
}
export type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}
export function parseArgs(argv: string[]): ReleaseOptions;
export function isIcloudPath(path: string, home?: string): boolean;
export function detectSigning(env: Env): {
  signed: boolean;
  source: string | null;
};
export function detectNotarization(
  env: Env,
): "api-key" | "apple-id" | "keychain-profile" | null;
export function planRelease(env: Env, options: ReleaseOptions): ReleasePlan;
export function buildReleaseConfig(
  base: any,
  plan: ReleasePlan,
  out: string,
): any;
export function notarytoolAuthArgs(env: Env): string[] | null;
export function expectedArtifactNames(version: string): {
  dmg: string;
  zip: string;
};
export function parseCodesignDisplay(text: string): CodesignInfo;
export function parseFuses(text: string): Record<string, boolean>;
export function expectedFuses(
  electronFuses: Record<string, boolean>,
): Record<string, boolean>;
export function diffFuses(
  actual: Record<string, boolean>,
  expected: Record<string, boolean>,
): string[];
export function check(
  name: string,
  status: CheckStatus,
  detail?: string,
): CheckResult;
export function hasFailure(results: CheckResult[]): boolean;
export function formatTable(results: CheckResult[]): string;
export function parseEntitlementKeys(text: string): string[];
export function buildEnv(env: Env, options: ReleaseOptions): Env;
