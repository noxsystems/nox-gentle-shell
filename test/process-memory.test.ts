import test from "node:test";
import assert from "node:assert/strict";
import {
  sampleProcessMemory,
  type ProcSource,
} from "../extensions/process-memory.js";

function fixture(rows: [number, number, number, string, string[]][]) {
  const reads: string[] = [];
  const source: ProcSource = {
    async list() {
      return rows.map(([pid]) => String(pid));
    },
    async read(pid, file) {
      reads.push(`${pid}/${file}`);
      const row = rows.find((r) => r[0] === pid);
      if (!row) throw new Error("exited");
      if (file === "stat")
        return `${pid} (program) S ${row[1]} ${Array(17).fill(0).join(" ")} 123 0`;
      if (file === "status") return `VmRSS:\t${row[2]} kB\n`;
      return row[4].join("\0") + "\0";
    },
    async executable(pid) {
      return rows.find((r) => r[0] === pid)![3];
    },
  };
  return { source, reads };
}

for (const phase of [
  "metadata",
  "identity",
  "rss",
  "exe",
  "argv",
  "post-validation",
]) {
  test(`failed ${phase} work drains siblings before settling and stops scheduling`, async () => {
    const { source } = fixture(
      Array.from({ length: 12 }, (_, i) => [
        i + 1,
        i ? 1 : 0,
        1,
        "/bin/node",
        ["node", "pi"],
      ]),
    );
    const releases: Array<() => void> = [];
    let notifyBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve;
    });
    let settled = false;
    let active = 0;
    let releasing = false;
    const visited: number[] = [];
    const gate = async (pid: number) => {
      visited.push(pid);
      if (pid === 1) throw new Error("first failure");
      if (releasing) return;
      active++;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 7) notifyBlocked();
      });
      active--;
    };
    const read = source.read;
    const executable = source.executable;
    const stats = new Map<number, number>();
    source.read = async (pid, file, limit) => {
      if (file === "stat") stats.set(pid, (stats.get(pid) ?? 0) + 1);
      const statPhase =
        phase === "metadata"
          ? 1
          : phase === "identity"
            ? 2
            : phase === "post-validation"
              ? 4
              : 0;
      if (
        (file === "stat" && stats.get(pid) === statPhase) ||
        (phase === "rss" && file === "status") ||
        (phase === "argv" && file === "cmdline")
      )
        await gate(pid);
      return read(pid, file, limit);
    };
    source.executable = async (pid) => {
      if (phase === "exe") await gate(pid);
      return executable(pid);
    };
    const sample = sampleProcessMemory({
      platform: "linux",
      rootPid: 1,
      source,
    }).then((value) => {
      settled = true;
      return value;
    });
    try {
      await blocked;
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.equal(active, 7);
      assert.equal(
        settled,
        false,
        "scan cannot settle while sibling reads remain active",
      );
    } finally {
      releasing = true;
      releases.forEach((resolve) => resolve());
      assert.deepEqual(await sample, {});
      for (let i = 0; i < 30; i++) await Promise.resolve();
    }
    assert.equal(active, 0);
    assert.deepEqual(
      visited,
      [1, 2, 3, 4, 5, 6, 7, 8],
      "failure prevents work on the remaining population",
    );
  });
}

test("unique tree includes nested Pi once; LSP is a subset and unrelated RSS is never read", async () => {
  const { source, reads } = fixture([
    [1, 0, 10, "/usr/bin/node", ["node", "pi"]],
    [
      2,
      1,
      20,
      "/usr/bin/node",
      ["node", "/pkg/typescript/lib/tsserver.js", "--serverMode", "semantic"],
    ],
    [3, 1, 30, "/usr/bin/node", ["node", "pi"]],
    [
      4,
      3,
      40,
      "/usr/bin/node",
      ["node", "/pkg/typescript/lib/typingsInstaller.js"],
    ],
    [5, 0, 999, "/usr/bin/node", ["node", "/pkg/typescript/lib/tsserver.js"]],
  ]);
  assert.deepEqual(
    await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
    { treeBytes: 100 * 1024, lspBytes: 60 * 1024 },
  );
  assert.ok(!reads.includes("5/status") && !reads.includes("5/cmdline"));
});

test("exact Pi process titles preserve nested TypeScript LSP totals", async () => {
  for (const executable of ["/usr/bin/node", "/usr/bin/nodejs"]) {
    for (const argv of [
      ["pi"],
      ["pi", "", "", ""],
      ["pi", ...Array<string>(36).fill("")],
    ]) {
      const { source } = fixture([
        [1, 0, 10, executable, ["pi"]],
        [2, 1, 20, executable, argv],
        [
          3,
          2,
          30,
          "/usr/bin/node",
          ["node", "/pkg/typescript/lib/tsserver.js"],
        ],
      ]);
      assert.deepEqual(
        await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
        { treeBytes: 61440, lspBytes: 30720 },
      );
    }
  }
});

test("Pi title recognition excludes substantive arguments and unknown programs", async () => {
  for (const [executable, argv] of [
    ["/usr/bin/node", ["pi", "unexpected"]],
    ["/usr/bin/node", ["pi", "", "unexpected"]],
    ["/usr/bin/node", ["other-program", "", ""]],
    ["/usr/bin/custom-server", ["pi", "", ""]],
  ] as Array<[string, string[]]>) {
    const { source } = fixture([
      [1, 0, 10, "/usr/bin/node", ["pi"]],
      [2, 1, 20, executable, argv],
      [3, 2, 30, "/usr/bin/node", ["node", "/pkg/typescript/lib/tsserver.js"]],
    ]);
    assert.deepEqual(
      await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
      { treeBytes: 61440, lspBytes: undefined },
    );
  }
});

test("real zero differs from unsupported and unavailable metrics", async () => {
  const { source } = fixture([[1, 0, 0, "/bin/node", ["node", "pi"]]]);
  assert.deepEqual(
    await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
    { treeBytes: 0, lspBytes: 0 },
  );
  assert.deepEqual(
    await sampleProcessMemory({ platform: "darwin", source }),
    {},
  );
  source.read = async () => {
    throw new Error("denied");
  };
  assert.deepEqual(
    await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
    {},
  );
});

test("shell text and Node eval are not LSP programs; actual wrappers and partial servers are", async () => {
  const { source } = fixture([
    [1, 0, 1, "/bin/node", ["node", "pi"]],
    [2, 1, 2, "/bin/bash", ["bash", "-c", "node /pkg/tsserver.js"]],
    [
      3,
      1,
      3,
      "/bin/node",
      ["node", "-e", "typescript-language-server tsserver.js"],
    ],
    [
      4,
      1,
      4,
      "/bin/node",
      ["node", "/pkg/typescript-language-server/lib/cli.mjs"],
    ],
    [
      5,
      1,
      5,
      "/bin/node",
      ["node", "/pkg/tsserver.js", "--serverMode", "partialSemantic"],
    ],
  ]);
  assert.deepEqual(
    await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
    { treeBytes: 15 * 1024, lspBytes: 9 * 1024 },
  );
});

test("unknown classifiers keep the tree but never claim complete LSP zero", async () => {
  const { source } = fixture([
    [1, 0, 1, "/bin/node", ["node", "pi"]],
    [2, 1, 2, "/bin/custom-server", ["custom-server"]],
  ]);
  assert.deepEqual(
    await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
    { treeBytes: 3072, lspBytes: undefined },
  );
  source.executable = async () => {
    throw new Error("exited");
  };
  assert.deepEqual(
    await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
    {},
  );
});

test("metadata precedes bounded parallel descendant reads; duplicates are not counted", async () => {
  const { source } = fixture(
    Array.from({ length: 20 }, (_, i) => [
      i + 1,
      i ? 1 : 0,
      1,
      "/bin/node",
      ["node", "pi"],
    ]),
  );
  const list = source.list;
  source.list = async () => [...(await list()), "1", "2", "self", "net"];
  const read = source.read;
  let active = 0;
  let maximum = 0;
  let initialStats = 0;
  source.read = async (pid, file, limit) => {
    active++;
    maximum = Math.max(maximum, active);
    assert.ok(limit <= 16384);
    if (file !== "stat") assert.ok(initialStats >= 20);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const value = await read(pid, file, limit);
    if (file === "stat") initialStats++;
    active--;
    return value;
  };
  assert.deepEqual(
    await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
    { treeBytes: 20480, lspBytes: 0 },
  );
  assert.ok(maximum <= 8);
});

test("descendant exit and changed parent fail closed", async () => {
  for (const failure of ["exit", "parent"]) {
    const { source } = fixture([
      [1, 0, 1, "/bin/node", ["node", "pi"]],
      [2, 1, 1, "/bin/node", ["node", "/pkg/tsserver.js"]],
    ]);
    const read = source.read;
    let childStats = 0;
    source.read = async (pid, file, limit) => {
      const value = await read(pid, file, limit);
      if (pid === 2 && file === "stat" && ++childStats > 1) {
        if (failure === "exit") throw new Error("exited");
        return value.replace("S 1 ", "S 0 ");
      }
      return value;
    };
    assert.deepEqual(
      await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
      {},
    );
  }
});

test("malformed, truncated, oversized population and identity churn fail closed", async () => {
  for (const failure of [
    "stat",
    "status",
    "cmdline",
    "identity",
    "population",
  ]) {
    const { source } = fixture([[1, 0, 1, "/bin/node", ["node", "pi"]]]);
    const read = source.read;
    let stats = 0;
    source.read = async (pid, file, limit) => {
      if (failure === file)
        return file === "cmdline" ? "x".repeat(limit + 1) : "invalid";
      const value = await read(pid, file, limit);
      if (file === "stat" && failure === "identity" && ++stats > 1)
        return value.replace("123", "124");
      return value;
    };
    if (failure === "population")
      source.list = async () =>
        Array.from({ length: 4097 }, (_, i) => String(i + 1));
    assert.deepEqual(
      await sampleProcessMemory({ platform: "linux", rootPid: 1, source }),
      {},
      failure,
    );
  }
});
