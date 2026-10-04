import { open, opendir, readlink } from "node:fs/promises";
import { basename } from "node:path";

/** RSS sums overlap shared pages and are not atomic snapshots. */
export interface ProcessMemorySnapshot {
  lspBytes?: number;
  treeBytes?: number;
}
export interface ProcSource {
  list(): Promise<string[]>;
  /** Return at most limit bytes, or reject on truncation. */
  read(
    pid: number,
    file: "stat" | "status" | "cmdline",
    limit: number,
  ): Promise<string>;
  executable(pid: number): Promise<string>;
}
const POPULATION_LIMIT = 4096;
const LIMITS = { stat: 4096, status: 16384, cmdline: 16384 } as const;
const procSource: ProcSource = {
  async list() {
    const entries: string[] = [];
    const directory = await opendir("/proc");
    for await (const entry of directory) {
      if (!/^[1-9]\d*$/.test(entry.name)) continue;
      entries.push(entry.name);
      if (entries.length > POPULATION_LIMIT)
        throw new Error("Process population limit");
    }
    return entries;
  },
  async read(pid, file, limit) {
    const handle = await open(`/proc/${pid}/${file}`, "r");
    try {
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > limit) throw new Error("Truncated proc data");
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
  },
  async executable(pid) {
    const value = await readlink(`/proc/${pid}/exe`);
    if (Buffer.byteLength(value) > 4096)
      throw new Error("Executable path limit");
    return value;
  },
};
interface Identity {
  pid: number;
  parent: number;
  start: string;
}
function identity(text: string, pid: number): Identity {
  const match = /^(\d+) \(.*\) ([\s\S]*)$/.exec(text.trim());
  if (!match || Number(match[1]) !== pid) throw new Error("Invalid stat");
  const fields = match[2].split(/\s+/);
  if (
    !/^[A-Za-z]$/.test(fields[0]) ||
    !/^\d+$/.test(fields[1]) ||
    !/^\d+$/.test(fields[19])
  )
    throw new Error("Invalid identity");
  const parent = Number(fields[1]);
  if (!Number.isSafeInteger(parent)) throw new Error("Invalid parent");
  return { pid, parent, start: fields[19] };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return (
    left.pid === right.pid &&
    left.parent === right.parent &&
    left.start === right.start
  );
}
/** Only executable names and the actual Node program argument; never source text. */
function classify(executable: string, argv: string[]): boolean | undefined {
  const name = basename(executable);
  const native = new Set([
    "typescript-language-server",
    "rust-analyzer",
    "clangd",
    "gopls",
    "lua-language-server",
    "pyright-langserver",
    "vscode-json-language-server",
    "vscode-css-language-server",
    "vscode-html-language-server",
  ]);
  if (native.has(name)) return true;
  if (["bash", "sh", "dash", "zsh", "fish"].includes(name)) return false;
  if (name !== "node" && name !== "nodejs") return undefined;
  // Pi replaces argv with its process title; proc may retain empty NUL padding.
  if (argv[0] === "pi" && argv.slice(1).every((argument) => argument === ""))
    return false;
  const script = argv[1];
  if (!script) return undefined;
  if (
    ["-e", "--eval", "-p", "--print"].includes(script) ||
    script.startsWith("--eval=") ||
    script.startsWith("--print=")
  )
    return false;
  // Unsupported Node flags cannot safely identify the program position.
  if (
    script.startsWith("-") ||
    script.length > 1024 ||
    /[\s\x00-\x1f]/.test(script)
  )
    return undefined;
  if (
    [
      "tsserver.js",
      "typingsInstaller.js",
      "typescript-language-server",
    ].includes(basename(script))
  )
    return true;
  if (
    /(?:^|\/)typescript-language-server\/(?:lib\/)?cli\.(?:m?js|cjs)$/.test(
      script,
    )
  )
    return true;
  if (
    basename(script) === "pi" ||
    /(?:^|\/)pi-coding-agent\/dist\/cli\.js$/.test(script)
  )
    return false;
  return undefined;
}
async function boundedMap<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  // Catch inside each worker so all started work drains before rejecting.
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          result[index] = await work(items[index]);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
      return undefined;
    }),
  );
  if (failed) throw firstError;
  return result;
}
export async function sampleProcessMemory(
  options: { platform?: string; rootPid?: number; source?: ProcSource } = {},
): Promise<ProcessMemorySnapshot> {
  if ((options.platform ?? process.platform) !== "linux") return {};
  const root = options.rootPid ?? process.pid;
  const source = options.source ?? procSource;
  const read = async (pid: number, file: keyof typeof LIMITS) => {
    const text = await source.read(pid, file, LIMITS[file]);
    if (Buffer.byteLength(text) > LIMITS[file])
      throw new Error("Truncated data");
    return text;
  };
  try {
    const entries = (await source.list()).filter((name) =>
      /^[1-9]\d*$/.test(name),
    );
    if (entries.length > POPULATION_LIMIT) return {};
    const pids = [...new Set(entries.map(Number))];
    if (!pids.includes(root) || pids.some((pid) => !Number.isSafeInteger(pid)))
      return {};
    // A missing metadata record could conceal a descendant. Fail closed.
    const metadata = await boundedMap(pids, async (pid) =>
      identity(await read(pid, "stat"), pid),
    );
    const selected = new Set([root]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const item of metadata) {
        if (!selected.has(item.pid) && selected.has(item.parent)) {
          selected.add(item.pid);
          changed = true;
        }
      }
    }
    const members = metadata.filter((item) => selected.has(item.pid));
    const byPid = new Map(metadata.map((item) => [item.pid, item]));
    if (selected.has(byPid.get(root)!.parent)) return {};
    for (const item of members) {
      if (item.pid === root) continue;
      const parent = byPid.get(item.parent);
      if (!parent || BigInt(parent.start) > BigInt(item.start)) return {};
    }
    const readings = await boundedMap(members, async (item) => {
      if (!sameIdentity(item, identity(await read(item.pid, "stat"), item.pid)))
        throw new Error("Identity changed");
      const status = await read(item.pid, "status");
      const rss = /^VmRSS:\s+(\d+) kB\s*$/m.exec(status);
      if (!rss) throw new Error("RSS unavailable");
      const bytes = Number(rss[1]) * 1024;
      if (!Number.isSafeInteger(bytes)) throw new Error("Invalid RSS");
      const executable = await source.executable(item.pid);
      if (!executable || executable.length > 4096)
        throw new Error("Invalid executable");
      const cmdline = await read(item.pid, "cmdline");
      if (!cmdline.endsWith("\0")) throw new Error("Incomplete argv");
      const lsp =
        item.pid === root
          ? false
          : classify(executable, cmdline.slice(0, -1).split("\0"));
      if (!sameIdentity(item, identity(await read(item.pid, "stat"), item.pid)))
        throw new Error("Identity changed");
      return { bytes, lsp };
    });
    // Revalidate parent links too, after all descendant readings.
    await boundedMap(members, async (item) => {
      if (!sameIdentity(item, identity(await read(item.pid, "stat"), item.pid)))
        throw new Error("Tree changed");
    });
    const treeBytes = readings.reduce((sum, reading) => sum + reading.bytes, 0);
    const lspBytes = readings.some((reading) => reading.lsp === undefined)
      ? undefined
      : readings.reduce(
          (sum, reading) => sum + (reading.lsp ? reading.bytes : 0),
          0,
        );
    if (
      !Number.isSafeInteger(treeBytes) ||
      (lspBytes !== undefined && !Number.isSafeInteger(lspBytes))
    )
      return {};
    return { treeBytes, lspBytes };
  } catch {
    return {};
  }
}
