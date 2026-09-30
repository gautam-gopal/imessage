import { io as connectClient } from "socket.io-client";
import { io as serverIo, server } from "../../src/lib/socket.js";
import { tokenFor } from "./factories.js";

// Polls until fn() is truthy. Real sockets are asynchronous; asserting on a
// fixed sleep would be flaky, so every "did X happen" check goes through this.
export async function waitFor(fn, { timeout = 3000, interval = 10, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Used for "nothing should arrive" assertions, always AFTER a positive
// signal has proven the pipeline is live.
export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

let baseUrl;
const clients = new Set();

export async function startSocketServer() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

export async function stopSocketServer() {
  await disconnectAll();
  await new Promise((resolve) => serverIo.close(resolve));
}

// Wraps a real socket.io-client. Every received event is logged so tests can
// assert on delivery and non-delivery. `authOverrides` lets a test add
// hostile handshake fields (e.g. a spoofed userId) next to the real token.
export function createClient({ token, authOverrides = {} } = {}) {
  const socket = connectClient(baseUrl, {
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    transports: ["websocket"],
    auth: { ...(token === undefined ? {} : { token }), ...authOverrides },
  });

  const received = [];
  socket.onAny((event, ...args) => received.push({ event, args }));
  clients.add(socket);

  const client = {
    socket,
    received,
    eventsOf: (name) => received.filter((r) => r.event === name).map((r) => r.args[0]),
    // `since` = how many events of this name to ignore (pass the count taken
    // just before the action under test), so a predicate can only match a NEW
    // event and never one already in the history.
    waitForEvent: (name, predicate = () => true, { since = 0, ...opts } = {}) =>
      waitFor(
        () => client.eventsOf(name).slice(since).find(predicate),
        { label: `event "${name}"`, ...opts },
      ),
    connect: () =>
      new Promise((resolve, reject) => {
        socket.once("connect", () => resolve(client));
        socket.once("connect_error", reject);
        socket.connect();
      }),
    disconnect: () => socket.disconnect(),
    markRead: (payload) => socket.timeout(3000).emitWithAck("message:read", payload),
  };
  return client;
}

export async function connectAs(user, authOverrides) {
  return createClient({ token: tokenFor(user), authOverrides }).connect();
}

// True once the server-side socket has joined `room`. Room joins after a
// handshake happen asynchronously (they need a DB query), so tests must wait.
export const inRoom = async (room, socketId) => {
  const sockets = await serverIo.in(String(room)).fetchSockets();
  return sockets.some((s) => s.id === socketId);
};

export const waitForRoom = (room, client) =>
  waitFor(() => inRoom(room, client.socket.id), { label: `socket in room ${room}` });

export async function disconnectAll() {
  for (const socket of clients) socket.disconnect();
  clients.clear();
  // Presence is module-level server state; wait until the server has
  // processed every disconnect so tests can't leak into each other.
  await waitFor(() => serverIo.sockets.sockets.size === 0, { label: "server sockets drained" });
}
