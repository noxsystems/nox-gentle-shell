import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  existsSync,
  rmSync,
  type Stats,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linuxCredentialLease,
  CredentialLockUnavailable,
} from "../extensions/spotify-lock.js";

let runtimeFixture: string | undefined;
let runtimeIdentity: Stats | undefined;
let originalRuntime: string | undefined;

before(() => {
  if (process.platform !== "linux") return;
  originalRuntime = process.env.XDG_RUNTIME_DIR;
  runtimeFixture = mkdtempSync(join(tmpdir(), "spotify-lock-runtime-"));
  chmodSync(runtimeFixture, 0o700);
  runtimeIdentity = lstatSync(runtimeFixture);
  assert.equal(runtimeIdentity.isDirectory(), true);
  assert.equal(runtimeIdentity.uid, process.getuid!());
  assert.equal(runtimeIdentity.mode & 0o777, 0o700);
  process.env.XDG_RUNTIME_DIR = runtimeFixture;
});

after(() => {
  if (process.platform !== "linux") return;
  if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntime;
  if (!runtimeFixture || !runtimeIdentity) return;
  const current = lstatSync(runtimeFixture);
  assert.equal(current.isDirectory(), true);
  assert.equal(current.uid, process.getuid!());
  assert.equal(current.mode & 0o777, 0o700);
  assert.equal(current.dev, runtimeIdentity.dev);
  assert.equal(current.ino, runtimeIdentity.ino);
  rmSync(runtimeFixture, { recursive: true });
});

test("real flock leases acquire, block, release and allow reacquisition", async () => {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return;
  const lease = linuxCredentialLease(2000);
  let release!: () => void;
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const held = lease.run(async () => {
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await entered;
  let second = false;
  const next = lease.run(async () => {
    second = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(second, false);
  release();
  await held;
  await next;
  assert.equal(second, true);
  const directory = join(process.env.XDG_RUNTIME_DIR, "nox-spotify-auth");
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(
    lstatSync(join(directory, "credential.lock")).mode & 0o777,
    0o600,
  );
});

test("descriptor lock excludes a different cwd and leaves no pathname 3", async () => {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return;
  const first = mkdtempSync(join(tmpdir(), "spotify-lock-first-"));
  const second = mkdtempSync(join(tmpdir(), "spotify-lock-second-"));
  const previous = process.cwd();
  process.chdir(first);
  try {
    const lease = linuxCredentialLease(2000);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = lease.run(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    try {
      const fd = openSync(
        join(
          process.env.XDG_RUNTIME_DIR,
          "nox-spotify-auth",
          "credential.lock",
        ),
        "r+",
      );
      try {
        const contender = spawn("flock", ["-x", "-w", "0.2", "3"], {
          cwd: second,
          stdio: ["ignore", "ignore", "ignore", fd],
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          contender.once("error", reject);
          contender.once("close", resolve);
        });
        assert.equal(
          code,
          1,
          "parent must retain the acquired descriptor after child exits",
        );
      } finally {
        closeSync(fd);
      }
    } finally {
      release();
      await held;
    }
    assert.equal(existsSync(join(first, "3")), false);
    assert.equal(existsSync(join(second, "3")), false);
    const fd = openSync(
      join(process.env.XDG_RUNTIME_DIR, "nox-spotify-auth", "credential.lock"),
      "r+",
    );
    try {
      const contender = spawn("flock", ["-x", "-w", "0.2", "3"], {
        cwd: second,
        stdio: ["ignore", "ignore", "ignore", fd],
      });
      assert.equal(
        await new Promise<number | null>((resolve, reject) => {
          contender.once("error", reject);
          contender.once("close", resolve);
        }),
        0,
        "final release permits acquisition from another cwd",
      );
    } finally {
      closeSync(fd);
    }
  } finally {
    process.chdir(previous);
  }
});

test("per-client intent leases are independent, cwd-safe and separate from credential lease", async () => {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return;
  const first = mkdtempSync(join(tmpdir(), "spotify-intent-first-"));
  const second = mkdtempSync(join(tmpdir(), "spotify-intent-second-"));
  const previous = process.cwd();
  process.chdir(first);
  let release!: () => void;
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const held = linuxCredentialLease(2000, "client-a").run(async () => {
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  try {
    await entered;
    process.chdir(second);
    let sameEntered = false;
    const same = linuxCredentialLease(2000, "client-a").run(async () => {
      sameEntered = true;
    });
    await linuxCredentialLease(2000, "client-b").run(async () => {});
    await linuxCredentialLease(2000).run(async () => {});
    assert.equal(sameEntered, false);
    release();
    await held;
    await same;
    assert.equal(sameEntered, true);
    assert.equal(existsSync(join(first, "3")), false);
    assert.equal(existsSync(join(second, "3")), false);
  } finally {
    release?.();
    await held;
    process.chdir(previous);
  }
});

test("aborted waiter releases its process and cannot run an operation", async () => {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return;
  const lease = linuxCredentialLease(2000);
  let release!: () => void;
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const held = lease.run(async () => {
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await entered;
  const controller = new AbortController();
  let called = false;
  const pending = assert.rejects(
    lease.run(async () => {
      called = true;
    }, controller.signal),
    CredentialLockUnavailable,
  );
  controller.abort();
  await pending;
  assert.equal(called, false);
  release();
  await held;
  await lease.run(async () => {});
});
