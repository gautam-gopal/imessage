import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import ConversationReadState from "../../src/models/conversation-read-state.model.js";
import {
  api,
  createUser,
  createDirect,
  createMessages,
} from "../helpers/factories.js";
import {
  startSocketServer,
  stopSocketServer,
  disconnectAll,
  connectAs,
  waitForRoom,
  settle,
} from "../helpers/socket-client.js";

beforeAll(startSocketServer);
afterAll(stopSocketServer);
afterEach(disconnectAll);

const unreadFor = async (user, conv) => {
  const rows = (await api(user).get("/api/messages/conversations")).body;
  return rows.find((r) => String(r._id) === String(conv._id)).unreadCount;
};

describe("unread count and the message:read socket event", () => {
  it("a socket read lowers the reader's unread count for every device", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const msgs = await createMessages(conv, [a], 3);
    const bTab = await connectAs(b);
    await waitForRoom(conv._id, bTab);

    expect(await unreadFor(b, conv)).toBe(3);

    const ack = await bTab.markRead({
      conversationId: String(conv._id),
      upToMessageId: String(msgs[2]._id),
    });

    expect(ack).toEqual({ ok: true, modifiedCount: 3 });
    // Counts are server-derived, so a second device (a fresh REST fetch)
    // sees the same value without any socket involvement.
    expect(await unreadFor(b, conv)).toBe(0);
  });

  it("a rejected read (non-member) does not create or move any watermark", async () => {
    const [a, b, outsider] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const conv = await createDirect(a, b);
    const msgs = await createMessages(conv, [a], 2);
    const outsiderClient = await connectAs(outsider);

    const ack = await outsiderClient.markRead({
      conversationId: String(conv._id),
      upToMessageId: String(msgs[1]._id),
    });

    expect(ack.ok).toBe(false);
    expect(await ConversationReadState.countDocuments()).toBe(0);
    expect(await unreadFor(b, conv)).toBe(2);
  });
});

describe("notification semantics: persistence, delivery, read, notification", () => {
  it("an offline recipient's message is persisted, retrievable, and counted exactly once across fetches and reconnects", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    // b has no open socket here.
    const send = await api(a)
      .post(`/api/messages/send/${b._id}`)
      .send({ text: "while offline" });
    expect(send.status).toBe(201);

    const history = await api(b).get(`/api/messages/${a._id}`);
    expect(history.body.messages.map((m) => m.text)).toEqual(["while offline"]);

    expect(await unreadFor(b, conv)).toBe(1);
    expect(await unreadFor(b, conv)).toBe(1); // repeated fetch is idempotent

    for (let i = 0; i < 2; i += 1) {
      const tab = await connectAs(b);
      await waitForRoom(conv._id, tab);
      await settle();

      // Reconnecting neither replays the event nor changes the count.
      expect(tab.eventsOf("newMessage")).toHaveLength(0);
      expect(await unreadFor(b, conv)).toBe(1);
      tab.socket.disconnect();
    }
  });

  it("live delivery to an online recipient is not a read: one event, one unread, until marked read", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const bTab = await connectAs(b);
    await waitForRoom(conv._id, bTab);

    await api(a).post(`/api/messages/send/${b._id}`).send({ text: "live" });
    const event = await bTab.waitForEvent(
      "newMessage",
      (m) => m.text === "live",
    );
    await settle();

    expect(bTab.eventsOf("newMessage")).toHaveLength(1);
    expect(await unreadFor(b, conv)).toBe(1);

    const ack = await bTab.markRead({
      conversationId: String(conv._id),
      upToMessageId: String(event._id),
    });
    expect(ack.ok).toBe(true);
    expect(await unreadFor(b, conv)).toBe(0);
  });
});
