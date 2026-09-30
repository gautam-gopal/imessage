import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import User from "../../src/models/user.model.js";
import { io as serverIo } from "../../src/lib/socket.js";
import {
  createUser,
  createDirect,
  createMessages,
  tokenFor,
} from "../helpers/factories.js";
import {
  startSocketServer,
  stopSocketServer,
  disconnectAll,
  createClient,
  connectAs,
  waitFor,
  waitForRoom,
  settle,
} from "../helpers/socket-client.js";

beforeAll(startSocketServer);
afterAll(stopSocketServer);
afterEach(disconnectAll);

describe("socket handshake authentication", () => {
  it("rejects a handshake with no token", async () => {
    await expect(createClient({}).connect()).rejects.toMatchObject({ message: "Unauthorized" });
  });

  it.each([
    ["empty token", ""],
    ["garbage token", "garbage"],
    ["malformed token", "test-token:"],
    ["token of the wrong shape", "Bearer abc.def.ghi"],
  ])("rejects %s", async (_label, token) => {
    await expect(createClient({ token }).connect()).rejects.toMatchObject({
      message: "Unauthorized",
    });
  });

  it("rejects a validly-signed identity that has no user profile", async () => {
    await expect(
      createClient({ token: "test-token:clerk_never_synced" }).connect(),
    ).rejects.toMatchObject({ message: "Unauthorized" });
  });

  it("does not register a rejected connection as online", async () => {
    const observer = await connectAs(await createUser());
    await createClient({ token: "garbage" }).connect().catch(() => {});
    await settle();

    expect(serverIo.sockets.sockets.size).toBe(1);
    // Only the observer's own connection produced a presence broadcast.
    expect(observer.eventsOf("getOnlineUsers")).toHaveLength(1);
  });

  it("derives identity from the token, ignoring a client-supplied userId", async () => {
    const [attacker, victimA, victimB, bystander] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const attackerOwn = await createDirect(attacker, bystander);
    const victimConv = await createDirect(victimA, victimB);
    const [message] = await createMessages(victimConv, [victimA], 1);

    // Valid token for `attacker`, hostile claim that we are victimA.
    const client = await connectAs(attacker, { userId: String(victimA._id) });
    await waitForRoom(attackerOwn._id, client);

    // Rooms were built from the token's identity, not the claim.
    expect(await serverIo.in(String(victimConv._id)).fetchSockets()).toHaveLength(0);

    // And authorization decisions use it too.
    const ack = await client.markRead({
      conversationId: String(victimConv._id),
      upToMessageId: String(message._id),
    });
    expect(ack).toEqual({ ok: false, error: "Conversation not found" });
  });
});

describe("multi-device presence", () => {
  const onlineIn = (client) => client.eventsOf("getOnlineUsers");

  it("broadcasts online once, on the first socket only", async () => {
    const [observerUser, a] = [await createUser(), await createUser()];
    const observer = await connectAs(observerUser);

    await connectAs(a);
    await observer.waitForEvent("getOnlineUsers", (ids) => ids.includes(String(a._id)));
    const broadcastsAfterFirst = onlineIn(observer).length;

    await connectAs(a); // second tab/device
    await settle();

    expect(onlineIn(observer)).toHaveLength(broadcastsAfterFirst);
  });

  it("keeps the user online while any device remains, and offline only after the last drops", async () => {
    const [observerUser, a] = [await createUser(), await createUser()];
    const observer = await connectAs(observerUser);
    const tab1 = await connectAs(a);
    const tab2 = await connectAs(a);
    await observer.waitForEvent("getOnlineUsers", (ids) => ids.includes(String(a._id)));
    const broadcasts = onlineIn(observer).length;

    tab1.disconnect();
    await waitFor(() => serverIo.sockets.sockets.size === 2, { label: "first tab closed" });
    await settle();

    // Still online: no broadcast, no lastSeenAt stamp.
    expect(onlineIn(observer)).toHaveLength(broadcasts);
    expect((await User.findById(a._id).lean()).lastSeenAt).toBeUndefined();

    tab2.disconnect();
    await observer.waitForEvent(
      "getOnlineUsers",
      (ids) => !ids.includes(String(a._id)),
    );
    await waitFor(async () => (await User.findById(a._id).lean()).lastSeenAt, {
      label: "lastSeenAt stamped",
    });
  });

  it("does not let one user's disconnect affect another user's presence", async () => {
    const [observerUser, a, b] = [await createUser(), await createUser(), await createUser()];
    const observer = await connectAs(observerUser);
    const aClient = await connectAs(a);
    await connectAs(b);
    await observer.waitForEvent("getOnlineUsers", (ids) => ids.includes(String(b._id)));
    const seen = onlineIn(observer).length;

    aClient.disconnect();
    const afterDrop = await observer.waitForEvent(
      "getOnlineUsers",
      (ids) => !ids.includes(String(a._id)),
      { since: seen },
    );

    expect(afterDrop).toContain(String(b._id));
  });

  it("reports a reconnecting user as online again", async () => {
    const [observerUser, a] = [await createUser(), await createUser()];
    const observer = await connectAs(observerUser);
    const first = await connectAs(a);
    await observer.waitForEvent("getOnlineUsers", (ids) => ids.includes(String(a._id)));

    const beforeDrop = onlineIn(observer).length;
    first.disconnect();
    await observer.waitForEvent(
      "getOnlineUsers",
      (ids) => !ids.includes(String(a._id)),
      { since: beforeDrop },
    );

    const beforeReconnect = onlineIn(observer).length;
    await createClient({ token: tokenFor(a) }).connect();

    await observer.waitForEvent(
      "getOnlineUsers",
      (ids) => ids.includes(String(a._id)),
      { since: beforeReconnect },
    );
  });
});
