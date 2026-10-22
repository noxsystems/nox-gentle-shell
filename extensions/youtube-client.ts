import { randomBytes } from "node:crypto";
import net from "node:net";
import {
  startBroker,
  type Broker,
  type BrokerPlayer,
  type Member,
  type Timer,
} from "./youtube-broker.js";
import {
  adoptTagFor,
  authMac,
  encode,
  endAndReap,
  lineReader,
  macMatches,
  parseBrokerMessage,
  type BrokerMessage,
  type ClientMessage,
  type LeaveOutcome,
  type SharedYoutube,
} from "./youtube-broker-protocol.js";
import {
  abstractFences,
  Aborted,
  checkpoint,
  createYoutubePlayer,
  isYoutubeUrl,
  npipeTransport,
  PlaylistEdgeError,
  unixSocketTransport,
  type WindowsMpv,
  type YoutubeAction,
  type YoutubeControl,
  type YoutubeSnapshot,
} from "./youtube-player.js";

/**
 * A Pi session's view of the shared YouTube player. Whoever binds the abstract socket first is
 * the broker and owns mpv; everyone else connects to it. When the broker's session closes or
 * dies, the clients race to bind the same name: the winner adopts the still-running mpv.
 */
export interface SharedYoutubeOptions {
  shared: SharedYoutube;
  /** Builds the player that owns mpv; only the session that becomes the broker calls it. */
  createPlayer(onChange: () => void): BrokerPlayer;
  onChange?: () => void;
  /** The election: resolves the listening server, or undefined when someone else holds the name. */
  bind?(address: string): Promise<net.Server | undefined>;
  connect?(address: string): Promise<net.Socket | undefined>;
  setTimer?(callback: () => void, ms: number): Timer;
  registerExit?(handler: () => void): () => void;
  graceMs?: number;
  retryMs?: number;
  joinTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** How long a quitting session keeps trying to end an mpv it cannot reach (elapsed time). */
  rescueDeadlineMs?: number;
  /** How long a quitting session waits for the broker to report what became of its goodbye. */
  leaveWaitMs?: number;
}
export interface SharedYoutubePlayer extends YoutubeControl {
  readonly role: "joining" | "client" | "host";
  dispose(reason?: string): Promise<void>;
}

const bindAbstract = (address: string) =>
  new Promise<net.Server | undefined>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(undefined));
    server.listen(address, () => resolve(server));
  });
const connectAbstract = (address: string) =>
  new Promise<net.Socket | undefined>((resolve) => {
    const socket = net.createConnection(address);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => {
      socket.destroy();
      resolve(undefined);
    });
  });
const timer = (callback: () => void, ms: number): Timer => {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};
const onProcessExit = (handler: () => void) => {
  process.once("exit", handler);
  return () => void process.off("exit", handler);
};

export function createSharedYoutubePlayer(
  options: SharedYoutubeOptions,
): SharedYoutubePlayer {
  const { shared } = options;
  const bind = options.bind ?? bindAbstract;
  const connect = options.connect ?? connectAbstract;
  const setTimer = options.setTimer ?? timer;
  const retryMs = options.retryMs ?? 100;
  const joinTimeout = options.joinTimeoutMs ?? 10_000;
  const handshakeTimeout = options.handshakeTimeoutMs ?? 2_000;
  const requestTimeout = options.requestTimeoutMs ?? 60_000;

  interface Link {
    send(message: ClientMessage): void;
    /** "orphaned": the connection ended before the broker reported an outcome. */
    leave(final: boolean): Promise<LeaveOutcome | "orphaned">;
  }
  let link: Link | undefined;
  let role: "joining" | "client" | "host" = "joining";
  let disposed = false;
  /** What dispose() was asked: a quit has no reload coming, so nobody may wait out a grace. */
  let disposedFinal = false;
  /** This session was a member at some point, so the broker may be holding an mpv for it. */
  let everLinked = false;
  /** A goodbye sent by a join that landed after dispose was never counted by the broker. */
  let abandonedUncounted = false;
  /** A join that landed after dispose was told the broker could not end mpv. */
  let abandonedFailed = false;
  const leaveWait = options.leaveWaitMs ?? 15_000;
  const rescueDeadline = options.rescueDeadlineMs ?? 5_000;
  let view: { snapshot?: YoutubeSnapshot; running: boolean } = {
    running: false,
  };
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer: Timer }
  >();
  const waiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: Timer;
  }>();

  const changed = () => options.onChange?.();
  const failAll = (error: Error) => {
    for (const request of pending.values()) {
      request.timer.cancel();
      request.reject(error);
    }
    pending.clear();
    for (const waiter of waiters) {
      waiter.timer.cancel();
      waiter.reject(error);
    }
    waiters.clear();
  };
  const linked = (next: Link, nextRole: "client" | "host") => {
    link = next;
    role = nextRole;
    everLinked = true;
    for (const waiter of waiters) {
      waiter.timer.cancel();
      waiter.resolve();
    }
    waiters.clear();
  };
  const onBroker = (message: BrokerMessage) => {
    if (message.type === "snapshot") {
      view = {
        running: message.running,
        ...(message.snapshot ? { snapshot: message.snapshot } : {}),
      };
      changed();
    } else if (message.type === "ack") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      request.timer.cancel();
      if (message.error === undefined) request.resolve();
      else
        request.reject(
          message.edge
            ? new PlaylistEdgeError(message.error)
            : new Error(message.error),
        );
    }
  };

  const waitForLink = () =>
    link
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const waiter = {
            resolve,
            reject,
            timer: setTimer(() => {
              waiters.delete(waiter);
              reject(new Error("YouTube player unavailable"));
            }, joinTimeout),
          };
          waiters.add(waiter);
        });
  const request = async (build: (id: number) => ClientMessage) => {
    checkpoint(() => !disposed, "YouTube player is closed");
    await waitForLink();
    // The link may have been dropped, or the session closed, while we waited for it.
    const current = link;
    checkpoint(() => !disposed, "YouTube player is closed");
    if (!current) throw new Aborted("YouTube player is closed");
    return new Promise<void>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {
        resolve,
        reject,
        timer: setTimer(() => {
          pending.delete(id);
          reject(new Error("YouTube player did not answer"));
        }, requestTimeout),
      });
      try {
        current.send(build(id));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  /** Connects to the broker and proves both sides know the secret; true once we are a client. */
  const handshake = (socket: net.Socket, mode: "join" | "rescue" = "join") =>
    new Promise<boolean>((resolve) => {
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      const nonce = randomBytes(16).toString("hex");
      let authenticated = false;
      let settled = false;
      let heardLeft: ((outcome: LeaveOutcome) => void) | undefined;
      let closed = false;
      /** Our link, once the broker has admitted us and the session still exists. */
      let mine: Link | undefined;
      let abandoning = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        if (!ok) socket.destroy();
        resolve(ok);
      };
      const deadline = setTimer(() => settle(false), handshakeTimeout);
      const read = lineReader(
        (line) => {
          const message = parseBrokerMessage(line);
          if (!message) return settle(false);
          if (authenticated) {
            // Only an outcome is a result. A bare acknowledgement says the goodbye was read, not
            // what became of mpv, and a connection that closes without an outcome stays uncounted.
            if (message.type === "left") {
              if (message.outcome) heardLeft?.(message.outcome);
            } else if (!abandoning) onBroker(message);
            return;
          }
          if (message.type === "hello")
            socket.write(
              encode({
                type: "auth",
                nonce,
                mac: authMac(shared.token, "client", message.nonce),
              }),
            );
          else if (
            message.type === "ready" &&
            macMatches(message.mac, authMac(shared.token, "broker", nonce))
          ) {
            authenticated = true;
            const say = (final: boolean) =>
              new Promise<LeaveOutcome | "orphaned">((done) => {
                // The goodbye only counts once the broker reports what became of it: a handoff
                // can drop this connection before the broker ever reads it. Real time bounds the
                // wait (longer than the handshake: the broker may be stopping mpv meanwhile).
                if (closed) return done("orphaned");
                const wait = setTimeout(() => done("orphaned"), leaveWait);
                wait.unref();
                heardLeft = (outcome) => {
                  clearTimeout(wait);
                  endAndReap(socket);
                  done(outcome);
                };
                socket.once("close", () => {
                  clearTimeout(wait);
                  done("orphaned");
                });
                socket.write(encode({ type: "bye", final }));
              });
            if (mode === "join" && disposed) {
              // The broker admitted us, but the session is already gone. Taking the link would
              // make us a member nobody speaks for: the host would hand mpv to a ghost. Leave.
              abandoning = true;
              void say(disposedFinal).then((result) => {
                if (result === "orphaned" && disposedFinal)
                  abandonedUncounted = true;
                if (result === "failed") abandonedFailed = true;
                settle(false);
              });
              return;
            }
            mine = {
              send: (m) => void socket.write(encode(m)),
              leave: say,
            };
            linked(mine, "client");
            settle(true);
          } else settle(false);
        },
        () => settle(false),
      );
      socket.on("data", (chunk: string) => read(chunk));
      socket.on("close", () => {
        closed = true;
        if (!authenticated) return settle(false);
        // Only the link this connection created is ours to drop: an abandoned join never had
        // one, and a rescue may have replaced it.
        if (!mine || link !== mine) return;
        // The broker went away: reconnect, or take over the name if we win the election.
        link = undefined;
        role = "joining";
        failAll(new Error("YouTube player connection lost"));
        if (!disposed) void join();
      });
    });

  let hosting:
    | { broker: Broker; member: Member; stopExit: () => void }
    | undefined;
  const becomeHost = (server: net.Server, rescuing = false) => {
    if (disposed && !rescuing) {
      server.close();
      return;
    }
    let broker: Broker | undefined;
    try {
      const player = options.createPlayer(() => broker?.broadcast());
      const started = startBroker(server, player, {
        token: shared.token,
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        setTimer,
        onEnded: () => hosting?.stopExit(),
      });
      broker = started;
      const member = started.join({ send: onBroker }, true);
      // A process that exits with the broker still serving would orphan mpv, unless another
      // session is left to adopt it.
      const stopExit = (options.registerExit ?? onProcessExit)(() => {
        if (started.clients <= (link ? 1 : 0)) player.emergencyKill();
      });
      hosting = { broker: started, member, stopExit };
      linked(
        {
          send: (m) => member.request(m),
          leave: (final) => member.leave(final),
        },
        "host",
      );
    } catch (error) {
      // A broker that never got going must not keep the name: the retry would find itself.
      server.close();
      throw error;
    }
  };

  /** One join at a time: two loops could each be admitted, and one would be a ghost. */
  let joining: Promise<void> | undefined;
  const join = () =>
    (joining ??= attemptJoin().finally(() => {
      joining = undefined;
    }));
  const attemptJoin = async () => {
    while (!disposed && !link) {
      try {
        const socket = await connect(shared.address);
        // Disposed while the connection was being made: it must not reach the broker as a member.
        checkpoint(
          () => !disposed,
          undefined,
          () => socket?.destroy(),
        );
        if (socket) {
          if (await handshake(socket)) return;
        } else {
          const server = await bind(shared.address);
          // becomeHost() rechecks and closes the name again if the session is gone by now.
          if (server) return becomeHost(server);
        }
      } catch (error) {
        if (error instanceof Aborted) return;
        // Any other failure is retried; waitForLink() reports a join that never succeeds.
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs).unref());
    }
  };
  void join();

  const abandonedMessage =
    "Could not end the shared YouTube player; mpv may still be playing";
  /**
   * Joins whoever holds the name now (or becomes the broker) just long enough to leave for good,
   * so an mpv the broker was about to hand over is not left with nobody to stop it. Bounded by
   * elapsed time; if it gives up while an mpv is known to be running, that is reported.
   */
  const rescue = async () => {
    const known = view.running;
    const deadline = Date.now() + rescueDeadline;
    const remaining = () => Math.max(0, deadline - Date.now());
    /**
     * Every await in here is raced against what is left of the deadline, so a connect, bind or
     * handshake that never answers cannot hold the shutdown. A result that arrives after we gave
     * up is disposed by `late`: a socket is destroyed, a server closed, a member left.
     */
    const bounded = async <T>(task: Promise<T>, late?: (value: T) => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const out = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining());
        timer.unref();
      });
      const settled = task.then(
        (value) => ({ value }),
        () => ({ value: undefined as T | undefined }),
      );
      void settled.then((r) => {
        if (expired && r.value !== undefined) late?.(r.value as T);
      });
      try {
        const winner = await Promise.race([settled, out]);
        if (winner === "timeout") {
          expired = true;
          return "timeout" as const;
        }
        return winner.value;
      } finally {
        clearTimeout(timer);
      }
    };
    let expired = false;
    /** The broker explicitly said it could not end mpv: reported whatever the view showed. */
    let failed = false;
    while (remaining() > 0 && !expired) {
      const socket = await bounded(connect(shared.address), (late) =>
        late?.destroy(),
      );
      if (socket === "timeout") break;
      if (socket) {
        const joined = await bounded(handshake(socket, "rescue"), (ok) => {
          if (ok) {
            void link?.leave(true);
            link = undefined;
          }
        });
        if (joined === "timeout") break;
        if (joined) {
          const again = await bounded(
            link?.leave(true) ?? Promise.resolve("left" as const),
          );
          link = undefined;
          if (again === "timeout") break;
          if (again === "failed") {
            failed = true;
            break;
          }
          if (again !== "orphaned") return;
        }
      } else {
        const server = await bounded(bind(shared.address), (late) =>
          late?.close(),
        );
        if (server === "timeout") break;
        if (server) {
          becomeHost(server, true);
          const member = hosting?.member;
          link = undefined;
          const left = await bounded(
            member?.leave(true) ?? Promise.resolve("ended" as const),
          );
          if (left === "timeout") break;
          if (left === "failed") {
            failed = true;
            break;
          }
          return;
        }
      }
      const slept = await bounded(
        new Promise<void>((resolve) => setTimeout(resolve, retryMs).unref()),
      );
      if (slept === "timeout") break;
    }
    if (!known && !failed) return;
    view = {
      running: true,
      snapshot: {
        paused: true,
        position: 0,
        updatedAt: Date.now(),
        error: abandonedMessage,
      },
    };
    changed();
    throw new Error(abandonedMessage);
  };

  return {
    get snapshot() {
      return view.snapshot;
    },
    get running() {
      return view.running;
    },
    get role() {
      return role;
    },
    play(url: string) {
      if (!isYoutubeUrl(url))
        return Promise.reject(new Error("Not a YouTube URL"));
      return request((id) => ({ type: "play", id, url }));
    },
    action: (action: YoutubeAction) =>
      request((id) => ({ type: "action", id, action })),
    stop: () => request((id) => ({ type: "stop", id })),
    async dispose(reason?: string) {
      if (disposed) return;
      disposed = true;
      // Only a quit has no reload coming to reconnect inside the grace period.
      const final = reason === undefined || reason === "quit";
      disposedFinal = final;
      failAll(new Error("YouTube player is closed"));
      const leaving = link;
      link = undefined;
      const result = await leaving?.leave(final);
      if (result === "failed") {
        // The broker could not end mpv and kept its name so it stays reachable. Say so: this
        // session is leaving, but the music is not stopped.
        view = {
          running: true,
          snapshot: {
            paused: true,
            position: 0,
            updatedAt: Date.now(),
            error: abandonedMessage,
          },
        };
        changed();
        throw new Error(abandonedMessage);
      }
      // A join that was in flight lands cleanly (it leaves by itself, see handshake) before we
      // decide anything else; real time bounds the wait.
      if (joining) {
        const bound = new Promise((resolve) =>
          setTimeout(resolve, handshakeTimeout).unref(),
        );
        await Promise.race([joining, bound]);
      }
      // Quitting for good while no broker counted our goodbye (it was handing mpv over, or we
      // were between brokers): nobody may be left to stop mpv, so end what we find ourselves.
      if (abandonedFailed) {
        view = {
          running: true,
          snapshot: {
            paused: true,
            position: 0,
            updatedAt: Date.now(),
            error: abandonedMessage,
          },
        };
        changed();
        throw new Error(abandonedMessage);
      }
      const uncounted =
        result === "orphaned" ||
        abandonedUncounted ||
        (leaving === undefined && everLinked);
      if (final && uncounted) await rescue();
    },
  };
}

/** The shared player when sharing is allowed here, else today's private per-session player. */
export function createYoutubeForSession(options: {
  shared: SharedYoutube | undefined;
  windows: WindowsMpv | string | undefined;
  onChange: () => void;
}): YoutubeControl {
  const { shared, windows, onChange } = options;
  if (!shared) return createYoutubePlayer({ windows, onChange });
  const transport =
    typeof windows === "object"
      ? npipeTransport(shared.pipeName, windows.relayPath)
      : unixSocketTransport(shared.mpvSocket);
  return createSharedYoutubePlayer({
    shared,
    onChange,
    createPlayer: (changed) =>
      createYoutubePlayer({
        windows,
        transport,
        adoptTag: adoptTagFor(shared.token),
        fence: abstractFences(shared.fence),
        onChange: changed,
      }),
  });
}
