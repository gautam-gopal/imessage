import { describe, it, expect } from "vitest";
import Message from "../../src/models/message.model.js";
import {
  api,
  createUser,
  createDirect,
  createGroup,
  createMessages,
  createMessage,
} from "../helpers/factories.js";

// The same pagination contract is served by two endpoints. Each case builds
// a conversation of `count` messages (m1 oldest .. mN newest) plus noise in
// an unrelated conversation, and returns how to page it.
const endpoints = {
  direct: async (count) => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const msgs = await createMessages(conv, [a, b], count);
    await createMessages(await createDirect(a, c), [a, c], 3); // noise
    return { viewer: a, path: `/api/messages/${b._id}`, msgs, conv };
  },
  group: async (count) => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const conv = await createGroup(a, [b, c]);
    const msgs = await createMessages(conv, [a, b, c], count);
    await createMessages(await createGroup(a, [b]), [a, b], 3); // noise
    return { viewer: a, path: `/api/conversations/${conv._id}/messages`, msgs, conv };
  },
};

const ids = (page) => page.messages.map((m) => String(m._id));

describe.each(Object.entries(endpoints))("cursor pagination (%s)", (_name, build) => {
  const fetchPage = async ({ viewer, path }, query = "") => {
    const res = await api(viewer).get(`${path}${query ? `?${query}` : ""}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  it("returns newest-first with a default limit of 30", async () => {
    const ctx = await build(35);
    const page = await fetchPage(ctx);

    expect(page.pageInfo.limit).toBe(30);
    expect(page.messages).toHaveLength(30);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(ids(page)).toEqual(ctx.msgs.slice(5).reverse().map((m) => String(m._id)));
  });

  it("honours limit, sets hasMore, and nextCursor is the oldest returned _id", async () => {
    const ctx = await build(25);
    const page = await fetchPage(ctx, "limit=10");

    expect(page.messages).toHaveLength(10);
    expect(page.pageInfo).toMatchObject({ limit: 10, hasMore: true });
    expect(page.pageInfo.nextCursor).toBe(ids(page).at(-1));
    expect(page.messages[0].text).toBe("m25");
    expect(page.messages.at(-1).text).toBe("m16");
  });

  it("walks the whole history with no overlap, no gaps, strict descending order", async () => {
    const ctx = await build(25);
    const seen = [];
    let cursor;
    let pages = 0;

    do {
      const page = await fetchPage(ctx, `limit=10${cursor ? `&before=${cursor}` : ""}`);
      const pageIds = ids(page);

      // Nothing on this page may have appeared on an earlier one.
      for (const id of pageIds) expect(seen).not.toContain(id);
      seen.push(...pageIds);

      if (page.pageInfo.hasMore) {
        expect(page.pageInfo.nextCursor).toBe(pageIds.at(-1));
      } else {
        expect(page.pageInfo.nextCursor).toBeNull();
      }
      cursor = page.pageInfo.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3); // 10 + 10 + 5
    expect(seen).toEqual(ctx.msgs.slice().reverse().map((m) => String(m._id)));
  });

  it("treats `before` as exclusive", async () => {
    const ctx = await build(5);
    const page = await fetchPage(ctx, `before=${ctx.msgs[3]._id}`); // before m4

    expect(ids(page)).toEqual([2, 1, 0].map((i) => String(ctx.msgs[i]._id)));
  });

  it("reports hasMore=false when the history exactly fits the limit", async () => {
    const ctx = await build(10);
    const exact = await fetchPage(ctx, "limit=10");
    const short = await fetchPage(ctx, "limit=9");

    expect(exact.pageInfo).toMatchObject({ hasMore: false, nextCursor: null });
    expect(exact.messages).toHaveLength(10);
    expect(short.pageInfo.hasMore).toBe(true);
  });

  it("returns an empty final page when the cursor is the oldest message", async () => {
    const ctx = await build(5);
    const page = await fetchPage(ctx, `before=${ctx.msgs[0]._id}`);

    expect(page.messages).toEqual([]);
    expect(page.pageInfo).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("never returns messages from another conversation", async () => {
    const ctx = await build(5);
    const page = await fetchPage(ctx, "limit=100");

    expect(page.messages).toHaveLength(5);
    for (const m of page.messages) {
      expect(String(m.conversationId)).toBe(String(ctx.conv._id));
    }
  });

  it("keeps readBy on paginated messages", async () => {
    const ctx = await build(3);
    const reader = await createUser();
    await Message.updateOne(
      { _id: ctx.msgs[1]._id },
      { $push: { readBy: { userId: reader._id, readAt: new Date() } } },
    );

    const page = await fetchPage(ctx);
    const target = page.messages.find((m) => String(m._id) === String(ctx.msgs[1]._id));

    expect(target.readBy.map((r) => String(r.userId))).toEqual([String(reader._id)]);
  });
});

describe("direct history with no conversation yet", () => {
  it("returns an empty page rather than an error", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const res = await api(a).get(`/api/messages/${b._id}?limit=5`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.pageInfo).toEqual({ limit: 5, hasMore: false, nextCursor: null });
  });
});

describe("ordering", () => {
  it("orders by _id, not createdAt", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const conv = await createDirect(a, b);
    const base = Date.now();
    // Inserted oldest-_id first, but createdAt runs the opposite way.
    const first = await createMessage(conv, a, { text: "first", createdAt: new Date(base + 3000) });
    const second = await createMessage(conv, b, { text: "second", createdAt: new Date(base + 2000) });
    const third = await createMessage(conv, a, { text: "third", createdAt: new Date(base + 1000) });

    const res = await api(a).get(`/api/messages/${b._id}`);

    expect(ids(res.body)).toEqual([third, second, first].map((m) => String(m._id)));
  });
});
