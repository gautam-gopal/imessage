import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Message from "../../src/models/message.model.js";
import { io as serverIo } from "../../src/lib/socket.js";
import {
  api,
  createUser,
  createSystemUser,
  createDirect,
  createGroup,
  createMessages,
} from "../helpers/factories.js";
import {
  startSocketServer,
  stopSocketServer,
  disconnectAll,
  connectAs,
  waitForRoom,
  inRoom,
  settle,
} from "../helpers/socket-client.js";

beforeAll(startSocketServer);
afterAll(stopSocketServer);
afterEach(disconnectAll);

const gotText = (client, text) => client.waitForEvent("newMessage", (m) => m.text === text);
const hasText = (client, text) => client.eventsOf("newMessage").some((m) => m.text === text);

describe("conversation room delivery (direct)", () => {
  it("delivers to every device of both participants and to nobody else", async () => {
    const [a, b, outsider] = [await createUser(), await createUser(), await createUser()];
    const conv = await createDirect(a, b);

    const [a1, a2, bClient, outsiderClient] = [
      await connectAs(a),
      await connectAs(a),
      await connectAs(b),
      await connectAs(outsider),
    ];
    await Promise.all([a1, a2, bClient].map((c) => waitForRoom(conv._id, c)));
    expect(await inRoom(conv._id, outsiderClient.socket.id)).toBe(false);

    const res = await api(b).post(`/api/messages/send/${a._id}`).send({ text: "direct-1" });
    expect(res.status).toBe(201);

    await Promise.all([a1, a2, bClient].map((c) => gotText(c, "direct-1")));
    await settle();
    expect(hasText(outsiderClient, "direct-1")).toBe(false);
  });

  it("adds already-connected sockets to a conversation created after they connected", async () => {
    const [a, b, outsider] = [await createUser(), await createUser(), await createUser()];
    const [aClient, bTab1, bTab2, outsiderClient] = [
      await connectAs(a),
      await connectAs(b),
      await connectAs(b),
      await connectAs(outsider),
    ];

    // First-ever message: the conversation does not exist yet.
    const res = await api(a).post(`/api/messages/send/${b._id}`).send({ text: "first-ever" });
    expect(res.status).toBe(201);

    await Promise.all([aClient, bTab1, bTab2].map((c) => gotText(c, "first-ever")));
    await settle();
    expect(hasText(outsiderClient, "first-ever")).toBe(false);
  });

  it("gives a client no way to join a room it is not a participant of", async () => {
    const [a, b, intruder] = [await createUser(), await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const intruderClient = await connectAs(intruder);
    const bClient = await connectAs(b);
    await waitForRoom(conv._id, bClient);

    // Every plausible self-service join attempt. The server defines no such
    // handler; the point is that none of them works.
    for (const event of ["join", "joinRoom", "join_room", "subscribe"]) {
      intruderClient.socket.emit(event, String(conv._id));
      intruderClient.socket.emit(event, { conversationId: String(conv._id) });
    }
    await settle();
    expect(await inRoom(conv._id, intruderClient.socket.id)).toBe(false);

    await api(b).post(`/api/messages/send/${a._id}`).send({ text: "private" });
    await gotText(bClient, "private");
    await settle();
    expect(hasText(intruderClient, "private")).toBe(false);
  });
});

describe("group room lifecycle follows membership", () => {
  it("joins members on creation, drops removed/leaving members, admits added members, and rebuilds from DB on reconnect", async () => {
    const [admin, b, c, d] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    // Gives C something to join on reconnect, so we can tell "join finished".
    const cdDirect = await createDirect(c, d);

    const [adminClient, bClient, cClient, dClient] = [
      await connectAs(admin),
      await connectAs(b),
      await connectAs(c),
      await connectAs(d),
    ];

    // --- creation: connected members join immediately, outsiders do not
    const created = await api(admin)
      .post("/api/conversations")
      .send({ name: "Room test", participantIds: [String(b._id), String(c._id)] });
    expect(created.status).toBe(201);
    const groupId = created.body._id;
    const post = (as, text) =>
      api(as).post(`/api/conversations/${groupId}/messages`).send({ text });

    await Promise.all([adminClient, bClient, cClient].map((x) => waitForRoom(groupId, x)));
    expect(await inRoom(groupId, dClient.socket.id)).toBe(false);

    await post(admin, "g1");
    await Promise.all([adminClient, bClient, cClient].map((x) => gotText(x, "g1")));
    await settle();
    expect(hasText(dClient, "g1")).toBe(false);

    // --- removal: C's live socket leaves the room and stops receiving
    const removed = await api(admin).delete(`/api/conversations/${groupId}/members/${c._id}`);
    expect(removed.status).toBe(200);
    expect(await inRoom(groupId, cClient.socket.id)).toBe(false);

    await post(b, "g2");
    await Promise.all([adminClient, bClient].map((x) => gotText(x, "g2")));
    await settle();
    expect(hasText(cClient, "g2")).toBe(false);

    // --- reconnect: rooms are rebuilt from DB, so C does not get back in
    cClient.disconnect();
    const cReconnected = await connectAs(c);
    await waitForRoom(cdDirect._id, cReconnected);
    expect(await inRoom(groupId, cReconnected.socket.id)).toBe(false);

    await post(admin, "g3");
    await gotText(bClient, "g3");
    await settle();
    expect(hasText(cReconnected, "g3")).toBe(false);

    // --- addition: D's already-connected socket joins immediately
    const added = await api(admin)
      .post(`/api/conversations/${groupId}/members`)
      .send({ memberId: String(d._id) });
    expect(added.status).toBe(200);
    await waitForRoom(groupId, dClient);

    await post(admin, "g4");
    await Promise.all([bClient, dClient].map((x) => gotText(x, "g4")));

    // --- self-leave: B stops receiving too
    const left = await api(b).delete(`/api/conversations/${groupId}/members/${b._id}`);
    expect(left.status).toBe(200);
    expect(await inRoom(groupId, bClient.socket.id)).toBe(false);

    await post(admin, "g5");
    await gotText(dClient, "g5");
    await settle();
    expect(hasText(bClient, "g5")).toBe(false);
  });
});

describe("message:read over the socket", () => {
  async function scene() {
    const [a, b, outsider] = [await createUser(), await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const msgs = await createMessages(conv, [a], 3); // all sent by A
    const [aClient, bTab1, bTab2, outsiderClient] = [
      await connectAs(a),
      await connectAs(b),
      await connectAs(b),
      await connectAs(outsider),
    ];
    await Promise.all([aClient, bTab1, bTab2].map((c) => waitForRoom(conv._id, c)));
    return { a, b, outsider, conv, msgs, aClient, bTab1, bTab2, outsiderClient };
  }

  const payloadFor = (conv, msg) => ({
    conversationId: String(conv._id),
    upToMessageId: String(msg._id),
  });

  it("persists the read, acks, and broadcasts to the whole room but not to outsiders", async () => {
    const { b, conv, msgs, aClient, bTab1, bTab2, outsiderClient } = await scene();

    const ack = await bTab1.markRead(payloadFor(conv, msgs[1]));

    expect(ack).toEqual({ ok: true, modifiedCount: 2 });
    for (const client of [aClient, bTab1, bTab2]) {
      const event = await client.waitForEvent("message:read");
      expect(event).toMatchObject({
        conversationId: String(conv._id),
        readerId: String(b._id),
        upToMessageId: String(msgs[1]._id),
      });
      expect(event.readAt).toBeTruthy();
    }

    const stored = await Message.find({ conversationId: conv._id }).sort({ _id: 1 }).lean();
    expect(stored.map((m) => (m.readBy ?? []).length)).toEqual([1, 1, 0]);
    expect(String(stored[0].readBy[0].userId)).toBe(String(b._id));

    await settle();
    expect(outsiderClient.eventsOf("message:read")).toHaveLength(0);
  });

  it("does not re-broadcast when nothing new was read", async () => {
    const { conv, msgs, aClient, bTab1 } = await scene();
    const payload = payloadFor(conv, msgs[2]);

    await bTab1.markRead(payload);
    await aClient.waitForEvent("message:read");
    const second = await bTab1.markRead(payload);
    await settle();

    expect(second).toEqual({ ok: true, modifiedCount: 0 });
    expect(aClient.eventsOf("message:read")).toHaveLength(1);
  });

  it("rejects a non-member, writes nothing, and broadcasts nothing", async () => {
    const { conv, msgs, aClient, outsiderClient } = await scene();

    const ack = await outsiderClient.markRead(payloadFor(conv, msgs[2]));
    await settle();

    expect(ack).toEqual({ ok: false, error: "Conversation not found" });
    expect(aClient.eventsOf("message:read")).toHaveLength(0);
    const stored = await Message.find({ conversationId: conv._id }).lean();
    expect(stored.every((m) => (m.readBy ?? []).length === 0)).toBe(true);
  });

  it("rejects an anchor from a different conversation", async () => {
    const { b, conv, bTab1 } = await scene();
    const other = await createUser();
    const foreignConv = await createDirect(b, other);
    const [foreign] = await createMessages(foreignConv, [other], 1);

    const ack = await bTab1.markRead({
      conversationId: String(conv._id),
      upToMessageId: String(foreign._id),
    });

    expect(ack).toEqual({ ok: false, error: "Message not found" });
    expect((await Message.findById(foreign._id).lean()).readBy ?? []).toHaveLength(0);
  });

  it.each([
    ["null payload", () => null],
    ["empty object", () => ({})],
    ["malformed conversationId", (p) => ({ ...p, conversationId: "nope" })],
    ["malformed upToMessageId", (p) => ({ ...p, upToMessageId: "nope" })],
    ["spoofed readerId field", (p) => ({ ...p, readerId: "someone-else" })],
  ])("rejects %s without touching the database", async (_label, mutate) => {
    const { conv, msgs, bTab1 } = await scene();

    const ack = await bTab1.markRead(mutate(payloadFor(conv, msgs[2])));

    expect(ack.ok).toBe(false);
    const stored = await Message.find({ conversationId: conv._id }).lean();
    expect(stored.every((m) => (m.readBy ?? []).length === 0)).toBe(true);
  });

  it("rejects system users", async () => {
    const a = await createUser();
    const bot = await createSystemUser();
    const conv = await createDirect(a, bot); // fixture-only
    const [message] = await createMessages(conv, [a], 1);
    const botClient = await connectAs(bot);
    await waitForRoom(conv._id, botClient);

    const ack = await botClient.markRead(payloadFor(conv, message));

    expect(ack).toEqual({ ok: false, error: "Forbidden" });
    expect((await Message.findById(message._id).lean()).readBy ?? []).toHaveLength(0);
  });

  it("uses the database, not room membership, as the security boundary", async () => {
    const [admin, member, removed] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(admin, [member, removed]);
    const [message] = await createMessages(group, [admin], 1);
    const [adminClient, removedClient] = [await connectAs(admin), await connectAs(removed)];
    await Promise.all([adminClient, removedClient].map((c) => waitForRoom(group._id, c)));

    await api(admin).delete(`/api/conversations/${group._id}/members/${removed._id}`);
    // Simulate stale delivery state: the socket is back in the room even
    // though the database says it has no right to be.
    await serverIo.in(removedClient.socket.id).socketsJoin(String(group._id));
    expect(await inRoom(group._id, removedClient.socket.id)).toBe(true);

    const ack = await removedClient.markRead(payloadFor(group, message));
    await settle();

    expect(ack).toEqual({ ok: false, error: "Conversation not found" });
    expect(adminClient.eventsOf("message:read")).toHaveLength(0);
    expect((await Message.findById(message._id).lean()).readBy ?? []).toHaveLength(0);
  });
});
