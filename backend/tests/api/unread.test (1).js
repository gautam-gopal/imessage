import { describe, it, expect } from "vitest";
import {
  api,
  createUser,
  createSystemUser,
  createDirect,
  createGroup,
  createMessage,
  createMessages,
} from "../helpers/factories.js";

const sidebar = async (user) => (await api(user).get("/api/messages/conversations")).body;
const rowFor = (rows, conversation) => rows.find((r) => String(r._id) === String(conversation._id));

describe("sidebar unreadCount: GET /api/messages/conversations", () => {
  it("reports unread per caller for direct conversations; the sender sees zero", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    await createMessages(conv, [a], 3);

    expect(rowFor(await sidebar(b), conv).unreadCount).toBe(3);
    expect(rowFor(await sidebar(a), conv).unreadCount).toBe(0);
  });

  it("reports unread for group conversations, independently per member", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(a, [b, c]);
    const msgs = await createMessages(group, [a], 4);

    await api(b)
      .post(`/api/conversations/${group._id}/read`)
      .send({ upToMessageId: String(msgs[2]._id) });

    expect(rowFor(await sidebar(b), group).unreadCount).toBe(1);
    expect(rowFor(await sidebar(c), group).unreadCount).toBe(4);
    expect(rowFor(await sidebar(a), group).unreadCount).toBe(0);
  });

  it("drops to zero after the REST read endpoint and rises with new messages", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const msgs = await createMessages(conv, [a], 2);

    const read = await api(b)
      .post(`/api/conversations/${conv._id}/read`)
      .send({ upToMessageId: String(msgs[1]._id) });
    expect(read.status).toBe(200);
    expect(rowFor(await sidebar(b), conv).unreadCount).toBe(0);

    await api(a).post(`/api/messages/send/${b._id}`).send({ text: "again" });
    expect(rowFor(await sidebar(b), conv).unreadCount).toBe(1);
  });

  it("counts AI (system user) messages as unread", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const ai = await createSystemUser();
    const conv = await createDirect(a, b);
    await createMessage(conv, ai, { text: "assistant reply" });

    expect(rowFor(await sidebar(a), conv).unreadCount).toBe(1);
  });

  it("does not leak another user's conversations or counts", async () => {
    const [a, b, outsider] = [await createUser(), await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    await createMessages(conv, [a], 2);

    expect(await sidebar(outsider)).toEqual([]);
  });
});

describe("adding a group member baselines unread", () => {
  it("existing history is read for the new member; later messages are unread", async () => {
    const [admin, b, newcomer] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(admin, [b]);
    await createMessages(group, [admin, b], 5);

    const add = await api(admin)
      .post(`/api/conversations/${group._id}/members`)
      .send({ memberId: String(newcomer._id) });
    expect(add.status).toBe(200);

    expect(rowFor(await sidebar(newcomer), group).unreadCount).toBe(0);

    await api(admin)
      .post(`/api/conversations/${group._id}/messages`)
      .send({ text: "welcome" });
    expect(rowFor(await sidebar(newcomer), group).unreadCount).toBe(1);
  });

  it("adding to a group with no messages leaves the first message unread", async () => {
    const [admin, b, newcomer] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(admin, [b]);

    await api(admin)
      .post(`/api/conversations/${group._id}/members`)
      .send({ memberId: String(newcomer._id) });
    await createMessage(group, admin);

    expect(rowFor(await sidebar(newcomer), group).unreadCount).toBe(1);
  });
});
