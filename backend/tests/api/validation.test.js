import { describe, it, expect } from "vitest";
import {
  api,
  createUser,
  createDirect,
  createGroup,
  createMessages,
  oid,
} from "../helpers/factories.js";

describe("history query validation (direct + group)", () => {
  const badQueries = [
    ["limit=0", "below minimum"],
    ["limit=101", "above maximum"],
    ["limit=abc", "non-numeric"],
    ["limit=1.5", "non-integer"],
    ["before=not-an-object-id", "malformed cursor"],
    ["before=12345", "short cursor"],
    ["bogus=1", "unknown parameter"],
  ];

  it.each(badQueries)("direct history rejects %s (%s)", async (query) => {
    const [a, b] = [await createUser(), await createUser()];
    const res = await api(a).get(`/api/messages/${b._id}?${query}`);
    expect(res.status).toBe(400);
  });

  it.each(badQueries)("group history rejects %s (%s)", async (query) => {
    const [a, b] = [await createUser(), await createUser()];
    const group = await createGroup(a, [b]);
    const res = await api(a).get(`/api/conversations/${group._id}/messages?${query}`);
    expect(res.status).toBe(400);
  });

  it("accepts boundary limits 1 and 100", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const group = await createGroup(a, [b]);
    for (const limit of [1, 100]) {
      const res = await api(a).get(`/api/conversations/${group._id}/messages?limit=${limit}`);
      expect(res.status).toBe(200);
    }
  });
});

describe("malformed ids", () => {
  it("rejects a malformed receiver id on history and send", async () => {
    const a = await createUser();
    expect((await api(a).get("/api/messages/nope")).status).toBe(400);
    expect((await api(a).post("/api/messages/send/nope").send({ text: "x" })).status).toBe(400);
  });

  it("rejects a malformed conversation id on every conversation route", async () => {
    const a = await createUser();
    const id = "nope";
    expect((await api(a).get(`/api/conversations/${id}/messages`)).status).toBe(400);
    expect((await api(a).post(`/api/conversations/${id}/messages`).send({ text: "x" })).status).toBe(400);
    expect((await api(a).post(`/api/conversations/${id}/read`).send({ upToMessageId: oid() })).status).toBe(400);
    expect((await api(a).post(`/api/conversations/${id}/members`).send({ memberId: oid() })).status).toBe(400);
    expect((await api(a).delete(`/api/conversations/${id}/members/${oid()}`)).status).toBe(400);
  });

  it("rejects a malformed member id on removal", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const group = await createGroup(a, [b]);
    expect((await api(a).delete(`/api/conversations/${group._id}/members/nope`)).status).toBe(400);
  });
});

describe("read-receipt input validation", () => {
  async function member() {
    const [a, b] = [await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const [m] = await createMessages(conv, [a], 1);
    return { b, conv, m };
  }

  it.each([
    ["missing upToMessageId", {}],
    ["malformed upToMessageId", { upToMessageId: "nope" }],
    ["non-string upToMessageId", { upToMessageId: 123 }],
    ["unexpected extra field", { upToMessageId: "VALID", userId: "x" }],
  ])("rejects %s", async (_label, body) => {
    const { b, conv, m } = await member();
    const payload = JSON.parse(JSON.stringify(body).replace("VALID", String(m._id)));
    const res = await api(b).post(`/api/conversations/${conv._id}/read`).send(payload);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a well-formed anchor that does not exist", async () => {
    const { b, conv } = await member();
    const res = await api(b)
      .post(`/api/conversations/${conv._id}/read`)
      .send({ upToMessageId: oid() });
    expect(res.status).toBe(404);
  });

  it("accepts a valid anchor", async () => {
    const { b, conv, m } = await member();
    const res = await api(b)
      .post(`/api/conversations/${conv._id}/read`)
      .send({ upToMessageId: String(m._id) });
    expect(res.status).toBe(200);
  });
});

describe("message body validation", () => {
  it("rejects an empty body and whitespace-only text", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const url = `/api/messages/send/${b._id}`;
    expect((await api(a).post(url).send({})).status).toBe(400);
    expect((await api(a).post(url).send({ text: "   " })).status).toBe(400);
  });

  it("rejects text over 5000 characters and unknown body fields", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const url = `/api/messages/send/${b._id}`;
    expect((await api(a).post(url).send({ text: "x".repeat(5001) })).status).toBe(400);
    expect((await api(a).post(url).send({ text: "ok", extra: 1 })).status).toBe(400);
  });
});

describe("group creation validation", () => {
  it.each([
    ["missing name", (p) => ({ participantIds: p })],
    ["blank name", (p) => ({ name: "  ", participantIds: p })],
    ["name over 100 chars", (p) => ({ name: "n".repeat(101), participantIds: p })],
    ["empty participantIds", () => ({ name: "G", participantIds: [] })],
    ["malformed participant id", () => ({ name: "G", participantIds: ["nope"] })],
    ["invalid avatar URL", (p) => ({ name: "G", avatar: "not a url", participantIds: p })],
    ["unknown field", (p) => ({ name: "G", participantIds: p, admins: [] })],
  ])("rejects %s", async (_label, build) => {
    const [a, b] = [await createUser(), await createUser()];
    const res = await api(a).post("/api/conversations").send(build([String(b._id)]));
    expect(res.status).toBe(400);
  });

  it("rejects a group whose only participant is the creator", async () => {
    const a = await createUser();
    const res = await api(a)
      .post("/api/conversations")
      .send({ name: "G", participantIds: [String(a._id)] });
    expect(res.status).toBe(400);
  });
});
