import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/axios", () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

import toast from "react-hot-toast";
import { axiosInstance } from "../src/lib/axios";
import { useChatStore } from "../src/store/useChatStore";
import { useAuthStore } from "../src/store/useAuthStore";
import {
  buildNotificationText,
  messagePreview,
  titleWithUnread,
  totalUnreadCount,
  unreadBadgeLabel,
} from "../src/lib/notifications";

const oid = (n) => n.toString(16).padStart(24, "0");
const ME = oid(1);
const PEER_A = oid(2);
const PEER_B = oid(3);
const CONV_A = oid(0xa0);
const CONV_B = oid(0xb0);
const CONV_NEW = oid(0xd0);
const GROUP = oid(0xc0);

const msg = (n, overrides = {}) => ({
  _id: oid(n),
  conversationId: CONV_B,
  senderId: PEER_B,
  text: `m${n}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  ...overrides,
});

const row = (id, peerId, name, unreadCount = 0) => ({
  _id: id,
  type: "direct",
  lastMessageAt: new Date(0).toISOString(),
  unreadCount,
  peer: { _id: peerId, fullName: name, profilePic: "" },
});

let listResponses;
const setList = (...rows) => {
  listResponses = rows;
};
const listCalls = () =>
  axiosInstance.get.mock.calls.filter(
    ([url]) => url === "/messages/conversations",
  ).length;

function createFakeSocket({ readAck = { ok: true, modifiedCount: 1 } } = {}) {
  const handlers = new Map();
  return {
    connected: true,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off(event, fn) {
      handlers.get(event)?.delete(fn);
    },
    trigger(event, ...args) {
      handlers.get(event)?.forEach((fn) => fn(...args));
    },
    timeout: () => ({ emit: (_e, _p, cb) => cb(null, readAck) }),
  };
}

const S = () => useChatStore.getState();
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function setup({ active = CONV_A, socketOptions } = {}) {
  await S().getConversations();
  S().setActiveConversationId(active);
  const socket = createFakeSocket(socketOptions);
  useAuthStore.setState({ socket });
  S().subscribeToMessages();
  axiosInstance.get.mockClear();
  return socket;
}

const initialState = useChatStore.getState();

beforeEach(() => {
  useChatStore.setState(initialState, true);
  useAuthStore.setState({ authUser: { _id: ME }, socket: null });
  vi.clearAllMocks();
  axiosInstance.get.mockReset();
  axiosInstance.post.mockReset();
  setList(row(CONV_A, PEER_A, "Peer A", 0), row(CONV_B, PEER_B, "Peer B", 2));
  axiosInstance.get.mockImplementation(async (url) => {
    if (url === "/messages/conversations") return { data: listResponses };
    throw new Error(`unmocked GET ${url}`);
  });
});

afterEach(() => {
  S().unsubscribeFromMessages();
  useAuthStore.setState({ socket: null });
  delete globalThis.document;
});

describe("notification helpers", () => {
  it("formats badges, totals, titles and previews", () => {
    expect(unreadBadgeLabel(0)).toBe("");
    expect(unreadBadgeLabel(7)).toBe("7");
    expect(unreadBadgeLabel(100)).toBe("99+");

    const list = [
      { id: "a", unreadCount: 3 },
      { id: "b", unreadCount: 4 },
    ];
    expect(totalUnreadCount(list, null)).toBe(7);
    expect(totalUnreadCount(list, "a")).toBe(4);

    expect(titleWithUnread("NexTalk", 0)).toBe("NexTalk");
    expect(titleWithUnread("NexTalk", 5)).toBe("(5) NexTalk");
    expect(titleWithUnread("NexTalk", 250)).toBe("(99+) NexTalk");

    expect(messagePreview({ text: "hi" })).toBe("hi");
    expect(messagePreview({ image: "x" })).toBe("📷 Photo");
    expect(messagePreview({ video: "x" })).toBe("🎥 Video");
    expect(messagePreview({ text: "a".repeat(200) })).toHaveLength(81);

    expect(
      buildNotificationText({
        conversation: { type: "group", name: "Team" },
        senderName: "Sam",
        message: { text: "yo" },
      }),
    ).toBe("Team · Sam: yo");
  });
});

describe("unreadCount in conversation state", () => {
  it("carries the server-derived count and defaults to zero", async () => {
    setList(row(CONV_A, PEER_A, "Peer A", 4), {
      ...row(CONV_B, PEER_B, "Peer B"),
      unreadCount: undefined,
    });
    await S().getConversations();

    const byId = Object.fromEntries(S().conversations.map((c) => [c.id, c]));
    expect(byId[CONV_A].unreadCount).toBe(4);
    expect(byId[CONV_B].unreadCount).toBe(0);
  });

  it("ignores a stale list response that arrives after a newer one", async () => {
    let releaseOld;
    axiosInstance.get.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) =>
            (releaseOld = () =>
              resolve({ data: [row(CONV_A, PEER_A, "Peer A", 9)] })),
        ),
    );
    const oldRequest = S().getConversations();
    setList(row(CONV_A, PEER_A, "Peer A", 1));
    await S().getConversations();

    releaseOld();
    await oldRequest;

    expect(S().conversations[0].unreadCount).toBe(1);
  });
});

describe("live message alerts", () => {
  it("alerts once and refreshes counts for a message in another conversation", async () => {
    const socket = await setup({ active: CONV_A });

    socket.trigger("newMessage", msg(10, { text: "hello there" }));
    await flush();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Peer B: hello there", {
      id: `msg-${oid(10)}`,
    });
    expect(listCalls()).toBe(1);
  });

  it("does not alert twice for the same message delivered twice", async () => {
    const socket = await setup({ active: CONV_A });

    socket.trigger("newMessage", msg(10));
    socket.trigger("newMessage", msg(10));
    await flush();

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("does not alert for the conversation in view, or for my own messages", async () => {
    const socket = await setup({ active: CONV_B });

    socket.trigger("newMessage", msg(10)); // in view
    socket.trigger("newMessage", msg(11, { senderId: ME })); // mine
    await flush();

    expect(toast).not.toHaveBeenCalled();
  });

  it("alerts for the active conversation when the tab is hidden", async () => {
    globalThis.document = { visibilityState: "hidden" };
    const socket = await setup({ active: CONV_B });

    socket.trigger("newMessage", msg(10));
    await flush();

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("learns the name of a brand-new conversation from the refreshed list", async () => {
    const socket = await setup({ active: CONV_A });
    setList(
      row(CONV_NEW, oid(9), "New Peer", 1),
      row(CONV_A, PEER_A, "Peer A", 0),
      row(CONV_B, PEER_B, "Peer B", 2),
    );

    socket.trigger(
      "newMessage",
      msg(10, { conversationId: CONV_NEW, senderId: oid(9), text: "first!" }),
    );
    await flush();

    expect(toast).toHaveBeenCalledWith("New Peer: first!", {
      id: `msg-${oid(10)}`,
    });
  });

  it("attributes group messages to the sender when known", async () => {
    setList({
      _id: GROUP,
      type: "group",
      name: "Team",
      participants: [ME, PEER_A],
      admins: [ME],
      participantCount: 2,
      lastMessageAt: new Date(0).toISOString(),
      unreadCount: 0,
    });
    useChatStore.setState({ users: [{ _id: PEER_A, fullName: "Sam" }] });
    const socket = await setup({ active: null });

    socket.trigger(
      "newMessage",
      msg(10, { conversationId: GROUP, senderId: PEER_A, text: "yo" }),
    );
    await flush();

    expect(toast).toHaveBeenCalledWith("Team · Sam: yo", {
      id: `msg-${oid(10)}`,
    });
  });

  it("a failing alert never blocks message delivery", async () => {
    toast.mockImplementationOnce(() => {
      throw new Error("toast exploded");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const socket = await setup({ active: CONV_A });

    expect(() => socket.trigger("newMessage", msg(10))).not.toThrow();
    await flush();

    expect(S().messagesByConversationId[CONV_B].map((m) => m._id)).toEqual([
      oid(10),
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("conversation-list refresh coalescing", () => {
  it("a burst of messages costs one in-flight request plus one follow-up", async () => {
    const socket = await setup({ active: CONV_A });
    let release;
    axiosInstance.get.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) => (release = () => resolve({ data: listResponses })),
        ),
    );

    for (let n = 10; n < 15; n += 1) socket.trigger("newMessage", msg(n));
    await flush();
    expect(listCalls()).toBe(1); // first still in flight, the rest queued

    release();
    await flush();
    expect(listCalls()).toBe(2); // exactly one follow-up for the whole burst
  });
});

describe("own read events and mark-read", () => {
  it("refreshes counts when I read (any device) but not when someone else reads", async () => {
    const socket = await setup({ active: CONV_A });

    socket.trigger("message:read", {
      conversationId: CONV_A,
      readerId: PEER_A,
      upToMessageId: oid(5),
      readAt: new Date().toISOString(),
    });
    await flush();
    expect(listCalls()).toBe(0);

    socket.trigger("message:read", {
      conversationId: CONV_A,
      readerId: ME,
      upToMessageId: oid(5),
      readAt: new Date().toISOString(),
    });
    await flush();
    expect(listCalls()).toBe(1);
  });

  it("refreshes after an ack with nothing newly marked, but defers to the broadcast otherwise", async () => {
    const socket = await setup({
      active: CONV_A,
      socketOptions: { readAck: { ok: true, modifiedCount: 0 } },
    });
    await S().markConversationRead(CONV_A, oid(5));
    await flush();
    expect(listCalls()).toBe(1);

    S().unsubscribeFromMessages();
    axiosInstance.get.mockClear();
    useAuthStore.setState({
      socket: createFakeSocket({ readAck: { ok: true, modifiedCount: 2 } }),
    });
    await S().markConversationRead(CONV_A, oid(6));
    await flush();
    expect(listCalls()).toBe(0);
    expect(socket).toBeTruthy();
  });
});

describe("reconnect catch-up", () => {
  it("refetches the list and the open thread's newest page, merging without duplicates and without alerts", async () => {
    axiosInstance.get.mockImplementation(async (url) => {
      if (url === "/messages/conversations") return { data: listResponses };
      if (url === `/messages/${PEER_A}`) {
        return {
          data: {
            messages: [
              msg(20, { conversationId: CONV_A, senderId: PEER_A }),
              msg(21, { conversationId: CONV_A, senderId: PEER_A }),
            ],
            pageInfo: { limit: 30, hasMore: false, nextCursor: null },
          },
        };
      }
      throw new Error(`unmocked GET ${url}`);
    });
    const socket = await setup({ active: CONV_A });
    // A message already received live before the drop:
    socket.trigger(
      "newMessage",
      msg(20, { conversationId: CONV_A, senderId: PEER_A }),
    );
    await flush();
    toast.mockClear();
    axiosInstance.get.mockClear();

    await S().catchUpAfterReconnect();
    await S().catchUpAfterReconnect(); // repeated reconnects are idempotent

    expect(S().messagesByConversationId[CONV_A].map((m) => m._id)).toEqual([
      oid(20),
      oid(21),
    ]);
    expect(toast).not.toHaveBeenCalled();
    expect(listCalls()).toBe(2);
  });

  it("only refetches the list when nothing is open", async () => {
    await setup({ active: null });

    await S().catchUpAfterReconnect();

    expect(axiosInstance.get).toHaveBeenCalledTimes(1);
  });
});
