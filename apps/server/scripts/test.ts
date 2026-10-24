// Runs the unit tests, then the end-to-end tests against the local murmur_test database.
// If the project-local PostgreSQL can't be started, the e2e tests are skipped with a message
// (so `npm test` at the repo root never fails just because Postgres is unavailable).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.MURMUR_PG_PORT ?? "54329";
const testUrl =
  process.env.MURMUR_TEST_DATABASE_URL ??
  `postgresql://murmur@127.0.0.1:${port}/murmur_test`;

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
const quiet = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const files = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
const nodeTest = (list: string[]) =>
  run(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", ...list],
    {
      MURMUR_TEST_DATABASE_URL: testUrl,
    },
  );

let failed = false;
failed = nodeTest(files("test/unit")).status !== 0 || failed;

const alreadyUp = quiet("bash", ["scripts/db.sh", "status"]).status === 0;
let ready = alreadyUp;
if (!alreadyUp) ready = quiet("bash", ["scripts/db.sh", "start"]).status === 0;

if (!ready) {
  console.log(
    "SKIPPED e2e tests: the local PostgreSQL could not be started (is postgresql@17 installed? see apps/server/README.md).",
  );
} else {
  const migrate = quiet("npx", ["prisma", "migrate", "deploy"], {
    DATABASE_URL: testUrl,
  });
  if (migrate.status !== 0) {
    console.error(migrate.stdout, migrate.stderr);
    failed = true;
  } else {
    failed = nodeTest(files("test/e2e")).status !== 0 || failed;
  }
  if (!alreadyUp) quiet("bash", ["scripts/db.sh", "stop"]);
}
process.exit(failed ? 1 : 0);
