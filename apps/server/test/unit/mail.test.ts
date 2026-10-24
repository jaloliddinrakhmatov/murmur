import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { ApiError } from "../../src/common/errors.ts";
import { CompositeMailer } from "../../src/mail/composite.mailer.ts";
import { mergeEnv } from "../../src/mail/env-file.ts";
import { renderHtml } from "../../src/mail/html.ts";
import type { EmailMessage, Mailer } from "../../src/mail/mailer.ts";
import { selectMailer } from "../../src/mail/select.ts";
import { parseSmtpConfig } from "../../src/mail/smtp.config.ts";
import type { SmtpConfig } from "../../src/mail/smtp.config.ts";
import { SmtpMailer } from "../../src/mail/smtp.mailer.ts";
import type { SmtpTransport } from "../../src/mail/smtp.mailer.ts";
import { updateEnvFile } from "../../src/mail/write-env.ts";

const config: SmtpConfig = {
  host: "smtp.gmail.com",
  port: 465,
  user: "owner@gmail.com",
  pass: "abcdefghijklmnop",
  from: '"Murmur" <owner@gmail.com>',
  secure: true,
};
const message: EmailMessage = {
  to: "friend@example.com",
  kind: "sign-in-code",
  subject: "Your Murmur sign-in code",
  text: "Your Murmur sign-in code is 123456. It works for 10 minutes.",
  secret: "123456",
  highlight: "123456",
};

class FakeTransport implements SmtpTransport {
  verifies = 0;
  sent: Parameters<SmtpTransport["sendMail"]>[0][] = [];
  failures: unknown[] = [];
  async verify() {
    this.verifies++;
    return true;
  }
  async sendMail(mail: Parameters<SmtpTransport["sendMail"]>[0]) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(mail);
    return {};
  }
}

/** Captures what the mailer logs. */
function captureLogs() {
  const lines: string[] = [];
  const original = [Logger.prototype.log, Logger.prototype.error];
  Logger.prototype.log = (m: unknown) => void lines.push(String(m));
  Logger.prototype.error = (m: unknown) => void lines.push(String(m));
  return {
    lines,
    restore() {
      [Logger.prototype.log, Logger.prototype.error] = original;
    },
  };
}

test("parseSmtpConfig: defaults, app-password spaces, TLS mode and bad input", () => {
  assert.equal(parseSmtpConfig({}), null);
  const c = parseSmtpConfig({
    MURMUR_SMTP_USER: "me@gmail.com",
    MURMUR_SMTP_PASS: "abcd efgh ijkl mnop",
  });
  assert.equal(c?.host, "smtp.gmail.com");
  // 587 (STARTTLS, required) by default: some networks block 465.
  assert.equal(c?.port, 587);
  assert.equal(c?.secure, false);
  assert.equal(c?.pass, "abcdefghijklmnop");
  assert.equal(c?.from, '"Murmur" <me@gmail.com>');
  const implicitTls = parseSmtpConfig({
    MURMUR_SMTP_USER: "me@gmail.com",
    MURMUR_SMTP_PASS: "x",
    MURMUR_SMTP_PORT: "465",
  });
  assert.equal(implicitTls?.secure, true);
  assert.throws(() => parseSmtpConfig({ MURMUR_SMTP_USER: "me@gmail.com" }));
  assert.throws(() =>
    parseSmtpConfig({ MURMUR_SMTP_USER: "nope", MURMUR_SMTP_PASS: "x" }),
  );
  assert.throws(() =>
    parseSmtpConfig({
      MURMUR_SMTP_USER: "me@gmail.com",
      MURMUR_SMTP_PASS: "x",
      MURMUR_SMTP_PORT: "99999",
    }),
  );
});

test("SmtpMailer: sends text + escaped HTML, verifies once, logs masked and never the password", async () => {
  const logs = captureLogs();
  try {
    const t = new FakeTransport();
    const mailer = new SmtpMailer(config, t, 0);
    await mailer.send(message);
    await mailer.send(message);
    assert.equal(t.verifies, 1);
    assert.equal(t.sent.length, 2);
    assert.equal(t.sent[0].from, config.from);
    assert.equal(t.sent[0].text, message.text);
    assert.match(t.sent[0].html, /font-size:28px[^>]*>123456</);
    const all = logs.lines.join("\n");
    assert.match(all, /f\*\*\*@example\.com/);
    assert.equal(all.includes("friend@example.com"), false);
    assert.equal(all.includes(config.pass), false);
    assert.equal(all.includes("123456"), false);
  } finally {
    logs.restore();
  }
});

test("SmtpMailer: retries once on a transient error, not on a login failure", async () => {
  const t = new FakeTransport();
  t.failures = [Object.assign(new Error("x"), { code: "ECONNRESET" })];
  await new SmtpMailer(config, t, 0).send(message);
  assert.equal(t.sent.length, 1);

  // A connection that timed out or was refused (a blocked port) fails at once, so the app's
  // request doesn't time out first and report the server as unreachable.
  for (const code of ["ETIMEDOUT", "ECONNREFUSED", "ECONNECTION"]) {
    const blocked = new FakeTransport();
    blocked.failures = [
      Object.assign(new Error("x"), { code }),
      new Error("must not be reached"),
    ];
    await assert.rejects(new SmtpMailer(config, blocked, 0).send(message));
    assert.equal(blocked.failures.length, 1, code);
  }

  const twice = new FakeTransport();
  twice.failures = [
    Object.assign(new Error("x"), { responseCode: 421 }),
    Object.assign(new Error("x"), { responseCode: 421 }),
  ];
  await assert.rejects(new SmtpMailer(config, twice, 0).send(message));
  assert.equal(twice.failures.length, 0);

  const auth = new FakeTransport();
  auth.failures = [
    Object.assign(new Error("x"), { code: "EAUTH", responseCode: 535 }),
    new Error("must not be reached"),
  ];
  await assert.rejects(new SmtpMailer(config, auth, 0).send(message));
  assert.equal(auth.failures.length, 1);
});

test("SmtpMailer: failure becomes a 502 server-error that leaks nothing", async () => {
  const logs = captureLogs();
  try {
    const t = new FakeTransport();
    t.failures = [
      Object.assign(
        new Error("535 bad login abcdefghijklmnop friend@example.com"),
        {
          code: "EAUTH",
          responseCode: 535,
        },
      ),
    ];
    await assert.rejects(new SmtpMailer(config, t, 0).send(message), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 502);
      assert.equal(e.code, "server-error");
      assert.equal(
        e.message,
        "Couldn't send the email. Try again in a minute.",
      );
      return true;
    });
    const all = logs.lines.join("\n");
    assert.equal(all.includes(config.pass), false);
    assert.equal(all.includes("friend@example.com"), false);
  } finally {
    logs.restore();
  }
});

test("SmtpMailer: a failed first verify is retried on the next send", async () => {
  const t = new FakeTransport();
  let fail = true;
  t.verify = async () => {
    t.verifies++;
    if (fail) throw Object.assign(new Error("x"), { code: "EAUTH" });
    return true;
  };
  const mailer = new SmtpMailer(config, t, 0);
  await assert.rejects(mailer.send(message));
  fail = false;
  await mailer.send(message);
  assert.equal(t.sent.length, 1);
});

test("renderHtml escapes everything, highlights the code, has no links", () => {
  const html = renderHtml(
    'Team "<b>x</b>" & co\n\nCode: ABCD-1234',
    "ABCD-1234",
  );
  assert.match(html, /&quot;&lt;b&gt;x&lt;\/b&gt;&quot; &amp; co/);
  assert.equal(html.includes("<b>"), false);
  assert.match(html, /font-size:28px[^>]*>ABCD-1234</);
  assert.equal(/<a |<script|<img/i.test(html), false);
});

test("CompositeMailer writes the outbox first, then sends", async () => {
  const order: string[] = [];
  const mk = (name: string, fail = false): Mailer => ({
    async send() {
      order.push(name);
      if (fail) throw new Error("boom");
    },
  });
  await new CompositeMailer(mk("outbox"), mk("smtp")).send(message);
  assert.deepEqual(order, ["outbox", "smtp"]);
  order.length = 0;
  await assert.rejects(
    new CompositeMailer(mk("outbox"), mk("smtp", true)).send(message),
  );
  assert.deepEqual(order, ["outbox", "smtp"]);
});

test("selectMailer: override, SMTP, development composite, outbox and production guard", () => {
  const dev: Mailer = { async send() {} };
  const smtp: Mailer = { async send() {} };
  const override: Mailer = { async send() {} };
  const create = () => smtp;
  assert.equal(
    selectMailer({ production: true, smtp: null }, override, dev),
    override,
  );
  assert.equal(
    selectMailer({ production: false, smtp: null }, undefined, dev),
    dev,
  );
  assert.ok(
    selectMailer(
      { production: false, smtp: config },
      undefined,
      dev,
      create,
    ) instanceof CompositeMailer,
  );
  assert.equal(
    selectMailer({ production: true, smtp: config }, undefined, dev, create),
    smtp,
  );
  assert.throws(
    () => selectMailer({ production: true, smtp: null }, undefined, dev),
    /email provider/,
  );
});

test("mergeEnv: replaces only the given keys, keeps other lines, appends new ones", () => {
  const before =
    "# comment\nPORT=4000\nMURMUR_SMTP_USER=old@x.com\n\nMURMUR_ENV=development\n";
  const after = mergeEnv(before, {
    MURMUR_SMTP_USER: "new@gmail.com",
    MURMUR_SMTP_PASS: "abcdefghijklmnop",
    MURMUR_MAIL_FROM: '"Murmur" <new@gmail.com>',
  });
  assert.equal(
    after,
    "# comment\nPORT=4000\nMURMUR_SMTP_USER=new@gmail.com\n\nMURMUR_ENV=development\nMURMUR_SMTP_PASS=abcdefghijklmnop\nMURMUR_MAIL_FROM='\"Murmur\" <new@gmail.com>'\n",
  );
  assert.equal(mergeEnv("", { A_B: "1" }), "A_B=1\n");
  assert.throws(() => mergeEnv("", { A: "x\ny" }));
  assert.throws(() => mergeEnv("", { "bad key": "x" }));
});

test("mergeEnv output is read back by Node's env-file parser", async () => {
  const { parseEnv } = await import("node:util");
  const text = mergeEnv("", {
    MURMUR_SMTP_USER: "me@gmail.com",
    MURMUR_MAIL_FROM: '"Murmur" <me@gmail.com>',
  });
  const parsed = parseEnv(text);
  assert.equal(parsed.MURMUR_MAIL_FROM, '"Murmur" <me@gmail.com>');
  assert.equal(parsed.MURMUR_SMTP_USER, "me@gmail.com");
});

test("updateEnvFile creates the file with mode 0600 and keeps it when updating", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-env-"));
  const path = join(dir, ".env");
  updateEnvFile(path, { MURMUR_SMTP_USER: "a@gmail.com" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, "KEEP=1\nMURMUR_SMTP_USER=a@gmail.com\n", {
    mode: 0o644,
  });
  updateEnvFile(path, { MURMUR_SMTP_USER: "b@gmail.com" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(path, "utf8"),
    "KEEP=1\nMURMUR_SMTP_USER=b@gmail.com\n",
  );
});
