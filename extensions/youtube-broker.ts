import { randomBytes } from "node:crypto";
import type net from "node:net";
import {
  authMac,
  encode,
  endAndReap,
  lineReader,
  macMatches,
  parseClientMessage,
  type BrokerMessage,
  type ClientMessage,
  type LeaveOutcome,
} from "./youtube-broker-protocol.js";
import {
  checkpoint,
  PlaylistEdgeError,
  type AdoptResult,
  type YoutubeAction,
  type YoutubeSnapshot,
} from "./youtube-player.js";

/**
 * The broker is the one process that owns mpv. Pi sessions are its members: they send
 * play/action/stop and read the snapshot it broadcasts. mpv lives while members do (plus a short
 * grace for /reload). It runs inside the first session; when that session closes while others
 * remain, it hands mpv over instead of stopping it (see youtube-client.ts).
 */

/** What the broker needs from the player that owns mpv. */
export interface BrokerPlayer {
  readonly snapshot: YoutubeSnapshot | undefined;
  readonly running: boolean;
  play(url: string): Promise<void>;
  action(action: YoutubeAction): Promise<void>;
  stop(): Promise<void>;
  adopt(): Promise<AdoptResult>;
  /** Lets go of mpv without ending it. */
  release(): void;
  /** Synchronous, for a process that is exiting. */
  emergencyKill(): void;
}
export interface Timer {
  cancel(): void;
}
export interface BrokerOptions {
  token: string;
  /** How long mpv outlives the last member, so /reload can reconnect. */
  graceMs?: number;
  authTimeoutMs?: number;
  /** How long a final goodbye waits for its outcome before the leaver is told "failed". */
  leaveDeadlineMs?: number;
  /** A request that has not finished by then is answered with an error and the queue moves on. */
  requestDeadlineMs?: number;
  /** Requests one member may have queued or running; more are refused at once. */
  maxPending?: number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  /** Called once, when the broker has stopped serving for good. */
  onEnded?: () => void;
}
export interface Sink {
  send(message: BrokerMessage): void;
}
/**
 * "failed": mpv could not be ended and is still running. The broker then keeps its name and its
 * ownership, so the mpv stays reachable and a later session can retry the stop.
 */
export type LeaveResult = "handoff" | "ended" | "grace" | "left" | "failed";
export interface Member {
  request(message: ClientMessage): void;
  /** final: the session is quitting, so waiting out the grace would outlive the process. */
  leave(final: boolean): Promise<LeaveResult>;
}
export interface Broker {
  /** An in-process member such as the host session; host members trigger a handoff on leave. */
  join(sink: Sink, host?: boolean): Member;
  broadcast(): void;
  readonly clients: number;
  readonly ended: Promise<void>;
}

const defaultTimer = (callback: () => void, ms: number): Timer => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};
/** Nothing a member sends may take the host's Pi session down with it. */
const guard = (task: () => void) => {
  try {
    task();
  } catch {
    // Deliberately dropped: a misbehaving member costs only its own request.
  }
};
const MAX_BACKLOG = 1 << 20;

export function startBroker(
  server: net.Server,
  player: BrokerPlayer,
  options: BrokerOptions,
): Broker {
  const graceMs = options.graceMs ?? 3_000;
  const authTimeoutMs = options.authTimeoutMs ?? 2_000;
  const requestDeadlineMs = options.requestDeadlineMs ?? 30_000;
  const maxPending = options.maxPending ?? 8;
  const setTimer = options.setTimer ?? defaultTimer;
  interface Entry {
    sink: Sink;
    host: boolean;
    close: () => void;
    /** False once the member has left: nothing of theirs may run or be answered. */
    alive: boolean;
    /** Requests queued or running for this member. */
    pending: number;
  }
  interface Job {
    entry: Entry;
    message: ClientMessage;
    /** Answers the request exactly once (result or deadline) and frees the drainer. */
    settle: (error?: unknown) => void;
    /** Resolved by settle() once the drainer has started this job. */
    release?: () => void;
    started: boolean;
    settled: boolean;
    deadline: Timer;
  }
  const members = new Set<Entry>();
  const sockets = new Set<net.Socket>();
  /** Connections whose goodbye is being processed: spared by closeServer until answered. */
  const leavers = new Set<net.Socket>();
  const leaveDeadlineMs = options.leaveDeadlineMs ?? 12_000;
  let state: "serving" | "closing" | "done" = "serving";
  let grace: Timer | undefined;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => (finish = resolve));

  const probe = async (): Promise<AdoptResult> => {
    try {
      return await player.adopt();
    } catch {
      return "unknown";
    }
  };
  // Requests wait behind the startup probe, so nothing launches before the owner is known. Until
  // it answers, members get no snapshot: "nothing is playing" would be a guess.
  let probing = true;
  const startup = probe().then(() => {
    probing = false;
    broadcast();
  });

  const snapshotMessage = (): BrokerMessage => ({
    type: "snapshot",
    running: player.running,
    ...(player.snapshot ? { snapshot: player.snapshot } : {}),
  });
  function broadcast() {
    if (state === "done") return;
    for (const member of members)
      guard(() => member.sink.send(snapshotMessage()));
  }

  const jobs: Job[] = [];
  let draining: Promise<void> | undefined;
  let running: Job | undefined;
  const cancelJobs = (entry?: Entry) => {
    for (let index = jobs.length - 1; index >= 0; index--) {
      const job = jobs[index]!;
      if (entry && job.entry !== entry) continue;
      jobs.splice(index, 1);
      job.settled = true;
      job.deadline.cancel();
      job.entry.pending--;
    }
  };

  const reply = (entry: Entry, id: number, error?: unknown) => {
    if (!entry.alive) return;
    guard(() =>
      entry.sink.send({
        type: "ack",
        id,
        ...(error === undefined
          ? {}
          : {
              error: error instanceof Error ? error.message : String(error),
              ...(error instanceof PlaylistEdgeError ? { edge: true } : {}),
            }),
      }),
    );
  };
  /**
   * Whether a job may still act: it was not answered (deadline, shutdown), its member is still
   * here, and the broker is still serving. Every await inside a job ends in a checkpoint on this.
   */
  const jobLive = (job: Job) =>
    !job.settled && job.entry.alive && state === "serving";
  const perform = async (job: Job) => {
    const { message } = job;
    if (message.type === "play") {
      // Right before every launch: whatever the startup probe saw may be stale by now.
      const owner = await probe();
      // The probe can take long enough for the member to leave, the request to time out, or the
      // broker to start shutting down (stop() has then already run). Launching now would start
      // an mpv nobody asked for and nobody will end. No await separates this from play().
      checkpoint(() => jobLive(job), "YouTube request was cancelled");
      if (owner === "unknown")
        throw new Error("YouTube player state unknown; try again");
      if (owner === "foreign")
        throw new Error("Another program owns the YouTube player address");
      await player.play(message.url);
    } else if (message.type === "action") await player.action(message.action);
    else if (message.type === "stop") await player.stop();
  };
  /** Runs one job; it ends when the player finishes or when the job is settled early. */
  const execute = (job: Job) =>
    new Promise<void>((resolve) => {
      job.started = true;
      job.release = resolve;
      if (job.settled) return resolve();
      let work: Promise<void>;
      try {
        work = perform(job);
      } catch (error) {
        job.settle(error);
        return;
      }
      work.then(
        () => job.settle(),
        (error) => job.settle(error),
      );
    });
  const drain = async () => {
    await startup;
    for (;;) {
      // Clearing `draining` in the same turn as the emptiness check is what keeps a request
      // enqueued a moment later from finding a drainer that is already leaving.
      if (jobs.length === 0 || state !== "serving") {
        draining = undefined;
        return;
      }
      const job = jobs.shift()!;
      // A member that left while this waited has nothing to run.
      if (job.entry.alive && !job.settled) {
        running = job;
        await execute(job);
        running = undefined;
      }
      job.entry.pending--;
    }
  };
  const enqueue = (entry: Entry, message: ClientMessage) => {
    if (!entry.alive || message.type === "bye" || message.type === "auth")
      return;
    const id = (message as { id: number }).id;
    if (state !== "serving")
      return reply(entry, id, new Error("YouTube player is shutting down"));
    if (entry.pending >= maxPending)
      return reply(entry, id, new Error("Too many pending YouTube requests"));
    entry.pending++;
    const job: Job = {
      entry,
      message,
      started: false,
      settled: false,
      settle: (error) => {
        if (job.settled) return;
        job.settled = true;
        job.deadline.cancel();
        reply(entry, id, error);
        job.release?.();
      },
      // The deadline starts at enqueue: waiting in line is part of a request's time.
      deadline: setTimer(() => {
        if (!job.started) {
          // Still queued: take it out of the line.
          const index = jobs.indexOf(job);
          if (index >= 0) {
            jobs.splice(index, 1);
            entry.pending--;
          }
        }
        job.settle(new Error("YouTube request timed out"));
      }, requestDeadlineMs),
    };
    jobs.push(job);
    draining ??= drain();
  };

  const stopServing = () => {
    state = "closing";
    grace?.cancel();
    grace = undefined;
    // Nothing queued runs from here on; only the request already running may finish.
    cancelJobs();
  };
  /** The name is released last: only after mpv is stopped or handed over. */
  const closeServer = () =>
    new Promise<void>((resolve) => {
      // A member that is leaving for good still has an outcome to receive; its socket is closed
      // by the handler right after delivering it.
      for (const socket of sockets) if (!leavers.has(socket)) socket.destroy();
      for (const socket of [...sockets]) if (!leavers.has(socket)) sockets.delete(socket);
      const fallback = setTimeout(resolve, 500);
      fallback.unref();
      try {
        // Listening stops (and the name is freed) the moment close() is called; the callback only
        // waits for open connections. A leaver is still open, so do not wait for it.
        if (leavers.size > 0) queueMicrotask(resolve);
        server.close(() => {
          clearTimeout(fallback);
          resolve();
        });
      } catch {
        clearTimeout(fallback);
        resolve();
      }
    });
  const conclude = () => {
    state = "done";
    options.onEnded?.();
    finish();
  };
  const settle = async () => {
    await draining;
    await startup;
  };
  /**
   * Stops mpv. A stop that rejects while a known mpv still runs is a failure, not an ending:
   * the broker goes back to serving and KEEPS ITS NAME. The name is the only way to reach that
   * mpv again (a new session joins, sees the error snapshot, and can retry stop); releasing it
   * would leave an unreachable mpv with nobody to end it. A rejection with nothing running
   * (the mpv is gone) is an ordinary ending.
   */
  const stopOrKeep = async (): Promise<"stopped" | "failed"> => {
    let rejected = false;
    await player.stop().catch(() => void (rejected = true));
    if (rejected && player.running) {
      state = "serving";
      broadcast();
      return "failed";
    }
    return "stopped";
  };
  const end = async (): Promise<"ended" | "failed" | "skipped"> => {
    if (state !== "serving") return "skipped";
    stopServing();
    // A probe still deciding whether an mpv is ours must finish first: aborting it would leave
    // an adoptable mpv that nobody owns and nobody stops. It is bounded by the player's timeouts.
    await startup;
    // Stop next: it aborts a launch or probe that is still in flight, and the request that was
    // running is answered now instead of holding shutdown hostage until its deadline.
    const stopping = stopOrKeep();
    running?.settle(new Error("YouTube player is shutting down"));
    await settle();
    if ((await stopping) === "failed") return "failed";
    await closeServer();
    conclude();
    return "ended";
  };
  const handoff = async (): Promise<"handoff" | "ended" | "failed"> => {
    stopServing();
    await settle();
    // A leave can arrive while this was closing (the leaves are counted, not ignored): with
    // nobody left to adopt it, the music ends here instead of being orphaned.
    if (members.size === 0) {
      if ((await stopOrKeep()) === "failed") return "failed";
      await closeServer();
      conclude();
      return "ended";
    }
    player.release();
    for (const member of members) guard(member.close);
    members.clear();
    await closeServer();
    conclude();
    return "handoff";
  };

  const admit = (sink: Sink, host: boolean, close: () => void): Member => {
    if (state !== "serving") throw new Error("YouTube broker is shutting down");
    const entry: Entry = { sink, host, close, alive: true, pending: 0 };
    members.add(entry);
    grace?.cancel();
    grace = undefined;
    if (!probing) guard(() => sink.send(snapshotMessage()));
    return {
      request: (message) => enqueue(entry, message),
      async leave(final) {
        if (!members.delete(entry)) return "left";
        entry.alive = false;
        // Counted from here on, whatever state the broker is in. The leaver is told the OUTCOME
        // (by the connection handler) once this settles, not that it was heard.
        cancelJobs(entry);
        if (state !== "serving") return "left";
        if (host && members.size > 0) return handoff();
        if (members.size > 0) return "left";
        if (final) {
          const result = await end();
          return result === "failed" ? "failed" : "ended";
        }
        grace = setTimer(() => {
          grace = undefined;
          if (members.size === 0) void end();
        }, graceMs);
        return "grace";
      },
    };
  };

  server.on("error", () => {});
  server.on("connection", (socket) =>
    guard(() => {
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      // The name stays bound while mpv is being stopped, so late arrivals are turned away.
      if (state !== "serving") {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      const nonce = randomBytes(16).toString("hex");
      let member: Member | undefined;
      const timer = setTimer(() => {
        if (!member) socket.destroy();
      }, authTimeoutMs);
      const send = (message: BrokerMessage) => {
        if (socket.destroyed) return;
        if (socket.writableLength > MAX_BACKLOG) socket.destroy();
        else socket.write(encode(message));
      };
      const onLine = (line: string) => {
        const message = parseClientMessage(line);
        if (!message) {
          socket.destroy();
          return;
        }
        if (!member) {
          if (
            message.type !== "auth" ||
            message.nonce.length > 128 ||
            !macMatches(message.mac, authMac(options.token, "client", nonce))
          ) {
            socket.destroy();
            return;
          }
          timer.cancel();
          send({
            type: "ready",
            mac: authMac(options.token, "broker", message.nonce),
          });
          member = admit({ send }, false, () => socket.destroy());
        } else if (message.type === "bye") {
          const leaving = member;
          leavers.add(socket);
          let answered = false;
          // One answer, ever: the real outcome, or "failed" if it takes longer than the deadline
          // (a stop that cannot be proven finished must not read as ended).
          const answer = (outcome: LeaveOutcome) => {
            if (answered) return;
            answered = true;
            deadline.cancel();
            guard(() => send({ type: "left", outcome }));
            leavers.delete(socket);
            sockets.delete(socket);
            guard(() => endAndReap(socket));
          };
          const deadline = setTimer(() => answer("failed"), leaveDeadlineMs);
          leaving.leave(message.final).then(
            (outcome) => answer(outcome),
            () => answer("failed"),
          );
        }
        else if (message.type !== "auth") member.request(message);
      };
      const read = lineReader(
        (line) => guard(() => onLine(line)),
        () => socket.destroy(),
      );
      socket.on("data", (chunk: string) => guard(() => read(chunk)));
      socket.on("close", () => {
        timer.cancel();
        sockets.delete(socket);
        void member?.leave(false);
      });
      send({ type: "hello", nonce });
    }),
  );
  server.unref();

  return {
    join: (sink, host = false) => admit(sink, host, () => {}),
    broadcast,
    get clients() {
      return members.size;
    },
    ended,
  };
}
