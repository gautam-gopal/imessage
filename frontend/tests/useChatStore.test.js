import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only the network edge and the toast UI are replaced. The store, its
// reducers, merge logic and pagination bookkeeping all run for real.
vi.mock("../src/lib/axios", () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("react-hot-toast", () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

import { axiosInstance } from "../src/lib/axios";
import { useChatStore } from "../src/store/useChatStore";
import { useAuthStore } from "../src/store/useAuthStore";

// ---------- fixtures ----------------------------------------------------

// 24-char hex ids that sort like ObjectIds: bigger n == newer.
const oid = (n) => n.toString(16).padStart(24, "0");
const ME = oid(1);
const PEER_A = oid(2);
const PEER_B = oid(3);
const CONV_A = oid(0xa0);
const CONV_B = oid(0xb0);
const GROUP = oid(0xc0);
const BASE = Date.parse("2026-01-01T00:00:00Z");
const iso = (seconds) => new Date(BASE + seconds * 1000).toISOString();

// Direct message in CONV_A by default; sent by PEER_A to ME.
const msg = (n, overrides = {}) => ({
  _id: oid(n),
  conversationId: CONV_A,
  senderId: PEER_A,
  receiverId: ME,
  text: `m${n}`,
  createdAt: iso(n),
  ...overrides,
});
// Same, but authored by the logged-in user.
const mine = (n, overrides = {}) =>
  msg(n, { senderId: ME, receiverId: PEER_A, ...overrides });
const readEntry = (userId, seconds) => ({ userId, readAt: iso(seconds) });

const conversationRows = [
  { _id: CONV_A, type: "direct", lastMessageAt: iso(0), peer: { _id: PEER_A, fullName: "Peer A", profilePic: "" } },
  { _id: CONV_B, type: "direct", lastMessageAt: iso(0), peer: { _id: PEER_B, fullName: "Peer B", profilePic: "" } },
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeSocket() {
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
  };
}

// GET router: /messages/conversations is always answered; anything else goes
// to routes[url](config) and may return a promise to hold a request open.
function mockRoutes(routes = {}) {
  axiosInstance.get.mockImplementation(async (url, config) => {
    if (url === "/messages/conversations") return { data: conversationRows };
    const handler = routes[url];
    if (!handler) throw new Error(`unmocked GET ${url}`);
    return handler(config);
  });
}

const page = (messages, pageInfo) => ({ data: { messages, pageInfo } });
const pageInfo = (over = {}) => ({ limit: 30, hasMore: true, nextCursor: oid(0x50), ...over });

const S = () => useChatStore.getState();
const bucket = (conv) => S().messagesByConversationId[conv];
const ids = (conv) => (bucket(conv) ?? []).map((m) => m._id);
const readers = (message) => (message.readBy ?? []).map((r) => String(r.userId));

async function seedConversations(active = CONV_A) {
  await S().getConversations();
  S().setActiveConversationId(active);
  axiosInstance.get.mockClear();
}

function connectFakeSocket() {
  const socket = createFakeSocket();
  useAuthStore.setState({ socket });
  S().subscribeToMessages();
  return socket;
}

const initialState = useChatStore.getState();

beforeEach(() => {
  useChatStore.setState(initialState, true);
  useAuthStore.setState({ authUser: { _id: ME }, socket: null });
  vi.clearAllMocks();
  axiosInstance.get.mockReset();
  axiosInstance.post.mockReset();
  mockRoutes();
});

afterEach(() => {
  S().unsubscribeFromMessages();
  useAuthStore.setState({ socket: null });
  vi.restoreAllMocks();
});

// ---------- 1. conversation-keyed state ---------------------------------

describe("conversation-keyed message state", () => {
  it("stores messages under their own conversationId without leaking", () => {
    S().ingestMessages([msg(1), msg(2)]);
    S().ingestMessages([msg(3, { conversationId: CONV_B, senderId: PEER_B })]);

    expect(ids(CONV_A)).toEqual([oid(1), oid(2)]);
    expect(ids(CONV_B)).toEqual([oid(3)]);
    expect(Object.keys(S().messagesByConversationId).sort()).toEqual([CONV_A, CONV_B].sort());
  });

  it("stores a live message for a non-selected conversation in its own bucket", async () => {
    await seedConversations(CONV_A);
    const socket = connectFakeSocket();

    socket.trigger("newMessage", msg(7, { conversationId: CONV_B, senderId: PEER_B }));

    expect(ids(CONV_B)).toEqual([oid(7)]);
    expect(bucket(CONV_A)).toBeUndefined();
    expect(S().activeConversationId).toBe(CONV_A);
    // The sidebar is told about the new activity.
    await vi.waitFor(() =>
      expect(axiosInstance.get).toHaveBeenCalledWith("/messages/conversations"),
    );
  });

  it("keeps cached buckets when the selection changes", async () => {
    await seedConversations(CONV_A);
    S().ingestMessages([msg(1)]);
    const before = bucket(CONV_A);

    S().setActiveConversationId(CONV_B);
    S().setActiveConversationId(CONV_A);

    expect(bucket(CONV_A)).toBe(before);
  });

  it("does not misfile a batch that mixes conversations", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { addedCount } = S().ingestMessages([msg(1), msg(2, { conversationId: CONV_B })]);

    expect(addedCount).toBe(1);
    expect(ids(CONV_A)).toEqual([oid(1)]);
    expect(bucket(CONV_B)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

// ---------- 2. deduplication --------------------------------------------

describe("deduplication by _id", () => {
  it("stores the same message once, reporting only genuinely new messages", () => {
    expect(S().ingestMessages([msg(1)]).addedCount).toBe(1);
    expect(S().ingestMessages([msg(1)]).addedCount).toBe(0);
    expect(ids(CONV_A)).toEqual([oid(1)]);
  });

  it("stores one copy when a message arrives by history, POST response and socket echo", async () => {
    await seedConversations(CONV_A);
    const socket = connectFakeSocket();
    mockRoutes({ [`/messages/${PEER_A}`]: () => page([msg(1), msg(2)], pageInfo()) });
    const sent = mine(10);
    axiosInstance.post.mockResolvedValue({ data: sent });

    await S().getMessages();
    await S().sendMessage({ text: "hi" });
    socket.trigger("newMessage", sent); // sender's own room echo
    socket.trigger("newMessage", msg(2)); // live copy of a history message

    expect(ids(CONV_A)).toEqual([oid(1), oid(2), oid(10)]);
  });

  it("dedupes a late history response against a message that already arrived live", async () => {
    await seedConversations(CONV_A);
    const socket = connectFakeSocket();
    socket.trigger("newMessage", msg(3));
    mockRoutes({ [`/messages/${PEER_A}`]: () => page([msg(1), msg(2), msg(3)], pageInfo()) });

    await S().getMessages();

    expect(ids(CONV_A)).toEqual([oid(1), oid(2), oid(3)]);
  });
});

// ---------- 3. ordering -------------------------------------------------

describe("message ordering", () => {
  it("orders by createdAt ascending regardless of arrival order", () => {
    S().ingestMessages([msg(3), msg(1), msg(2)]);
    expect(ids(CONV_A)).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("breaks createdAt ties by _id ascending", () => {
    const at = iso(100);
    S().ingestMessages([
      msg(5, { createdAt: at }),
      msg(3, { createdAt: at }),
      msg(4, { createdAt: at }),
    ]);
    expect(ids(CONV_A)).toEqual([oid(3), oid(4), oid(5)]);
  });

  it("puts createdAt before _id (display order, not cursor order)", () => {
    S().ingestMessages([msg(2, { createdAt: iso(50) }), msg(9, { createdAt: iso(10) })]);
    expect(ids(CONV_A)).toEqual([oid(9), oid(2)]);
  });

  it("slots a late-arriving older message into its place", () => {
    S().ingestMessages([msg(1), msg(3)]);
    S().ingestMessages([msg(2)]);
    expect(ids(CONV_A)).toEqual([oid(1), oid(2), oid(3)]);
  });
});

// ---------- 4. read-receipt state ---------------------------------------

describe("readBy handling", () => {
  it("preserves server-provided readBy on ingestion", () => {
    S().ingestMessages([mine(1, { readBy: [readEntry(PEER_A, 5)] })]);
    expect(bucket(CONV_A)[0].readBy).toEqual([readEntry(PEER_A, 5)]);
  });

  it("does not let a stale copy without readBy erase an applied receipt", () => {
    S().ingestMessages([mine(1)]);
    S().applyReadReceipt({ conversationId: CONV_A, readerId: PEER_A, upToMessageId: oid(1), readAt: iso(9) });

    S().ingestMessages([mine(1)]); // e.g. a late POST response

    expect(readers(bucket(CONV_A)[0])).toEqual([PEER_A]);
  });

  it("unions readers from an existing and an incoming copy", () => {
    S().ingestMessages([mine(1, { readBy: [readEntry(PEER_A, 1)] })]);
    S().ingestMessages([mine(1, { readBy: [readEntry(PEER_B, 2)] })]);
    expect(readers(bucket(CONV_A)[0]).sort()).toEqual([PEER_A, PEER_B].sort());
  });

  it("keeps one entry per reader and the earliest readAt, whichever copy arrives first", () => {
    S().ingestMessages([mine(1, { readBy: [readEntry(PEER_A, 5)] })]);
    S().ingestMessages([mine(1, { readBy: [readEntry(PEER_A, 2)] })]);
    expect(bucket(CONV_A)[0].readBy).toHaveLength(1);
    expect(bucket(CONV_A)[0].readBy[0].readAt).toBe(iso(2));

    S().ingestMessages([mine(1, { readBy: [readEntry(PEER_A, 8)] })]);
    expect(bucket(CONV_A)[0].readBy).toHaveLength(1);
    expect(bucket(CONV_A)[0].readBy[0].readAt).toBe(iso(2));
  });
});

describe("applyReadReceipt", () => {
  const receipt = (over = {}) => ({
    conversationId: CONV_A,
    readerId: PEER_A,
    upToMessageId: oid(3),
    readAt: iso(20),
    ...over,
  });

  it("marks messages up to the anchor, skipping the reader's own and later ones", () => {
    S().ingestMessages([mine(1), msg(2), mine(3), mine(4)]); // m2 is PEER_A's own

    S().applyReadReceipt(receipt());

    const [m1, m2, m3, m4] = bucket(CONV_A);
    expect(readers(m1)).toEqual([PEER_A]);
    expect(readers(m2)).toEqual([]); // reader's own message
    expect(readers(m3)).toEqual([PEER_A]); // anchor is inclusive
    expect(readers(m4)).toEqual([]); // beyond the anchor
  });

  it("is idempotent: no duplicate reader and no state change on repeat", () => {
    S().ingestMessages([mine(1), mine(2)]);
    S().applyReadReceipt(receipt());
    const after = S().messagesByConversationId;

    S().applyReadReceipt(receipt());

    expect(S().messagesByConversationId).toBe(after);
    expect(readers(bucket(CONV_A)[0])).toEqual([PEER_A]);
  });

  it("tracks several group readers independently", () => {
    S().ingestMessages([
      { _id: oid(1), conversationId: GROUP, senderId: ME, text: "hi", createdAt: iso(1) },
    ]);
    const base = { conversationId: GROUP, upToMessageId: oid(1), readAt: iso(5) };

    S().applyReadReceipt({ ...base, readerId: PEER_A });
    S().applyReadReceipt({ ...base, readerId: PEER_B });
    S().applyReadReceipt({ ...base, readerId: PEER_A });

    expect(readers(bucket(GROUP)[0]).sort()).toEqual([PEER_A, PEER_B].sort());
  });

  it("ignores a receipt for a conversation that isn't loaded", () => {
    S().applyReadReceipt(receipt({ conversationId: oid(0xee) }));
    expect(S().messagesByConversationId).toEqual({});
  });

  it("updates only the addressed bucket when message:read arrives over the socket", () => {
    S().ingestMessages([mine(1)]);
    S().ingestMessages([mine(2, { conversationId: CONV_B, receiverId: PEER_B })]);
    const bucketB = bucket(CONV_B);
    const socket = connectFakeSocket();

    socket.trigger("message:read", receipt({ upToMessageId: oid(1) }));

    expect(readers(bucket(CONV_A)[0])).toEqual([PEER_A]);
    expect(bucket(CONV_B)).toBe(bucketB); // untouched, same reference
  });

  it("ignores malformed message:read payloads", () => {
    S().ingestMessages([mine(1)]);
    const before = S().messagesByConversationId;
    const socket = connectFakeSocket();

    socket.trigger("message:read", { conversationId: CONV_A, upToMessageId: oid(1) }); // no readerId
    socket.trigger("message:read", { conversationId: CONV_A, readerId: PEER_A }); // no anchor
    socket.trigger("message:read", null);

    expect(S().messagesByConversationId).toBe(before);
  });

  it("derives the newest unread message from someone else as the read anchor", () => {
    S().ingestMessages([msg(1, { readBy: [readEntry(ME, 3)] }), msg(2), mine(3)]);
    expect(S().getUnreadReadAnchor(CONV_A)).toBe(oid(2));

    S().applyReadReceipt({ conversationId: CONV_A, readerId: ME, upToMessageId: oid(2), readAt: iso(9) });
    expect(S().getUnreadReadAnchor(CONV_A)).toBeNull();
  });
});

// ---------- 5. pagination state isolation -------------------------------

describe("pagination state per conversation", () => {
  const CURSOR_A = oid(0x51);
  const CURSOR_B = oid(0x52);

  // Loads the first page of both conversations, leaving CONV_A selected.
  async function loadFirstPages(routes = {}) {
    mockRoutes({
      [`/messages/${PEER_A}`]: () =>
        page([msg(5), msg(6)], pageInfo({ nextCursor: CURSOR_A })),
      [`/messages/${PEER_B}`]: () =>
        page([msg(8, { conversationId: CONV_B, senderId: PEER_B })], pageInfo({ hasMore: false, nextCursor: null })),
      ...routes,
    });
    await seedConversations(CONV_A);
    await S().getMessages();
    S().setActiveConversationId(CONV_B);
    await S().getMessages();
    S().setActiveConversationId(CONV_A);
  }

  it("keeps separate first-page metadata for each conversation", async () => {
    await loadFirstPages();

    expect(S().historyByConversationId[CONV_A]).toEqual({
      limit: 30, hasMore: true, nextCursor: CURSOR_A, isLoadingOlder: false,
    });
    expect(S().historyByConversationId[CONV_B]).toEqual({
      limit: 30, hasMore: false, nextCursor: null, isLoadingOlder: false,
    });
  });

  it("loading older messages for A leaves B's metadata and messages untouched", async () => {
    const olderRequests = [];
    await loadFirstPages();
    mockRoutes({
      [`/messages/${PEER_A}`]: (config) => {
        olderRequests.push(config);
        return page([msg(3), msg(4)], pageInfo({ hasMore: false, nextCursor: null }));
      },
    });
    const historyB = S().historyByConversationId[CONV_B];
    const bucketB = bucket(CONV_B);

    const result = await S().loadOlderMessages(CONV_A);

    expect(result).toEqual({ ok: true, addedCount: 2 });
    expect(olderRequests).toEqual([{ params: { before: CURSOR_A, limit: 30 } }]);
    expect(S().historyByConversationId[CONV_A]).toMatchObject({ hasMore: false, nextCursor: null });
    expect(ids(CONV_A)).toEqual([oid(3), oid(4), oid(5), oid(6)]);
    expect(S().historyByConversationId[CONV_B]).toBe(historyB);
    expect(bucket(CONV_B)).toBe(bucketB);
  });

  it("refuses a second older-page request while one is in flight", async () => {
    const gate = deferred();
    await loadFirstPages();
    mockRoutes({ [`/messages/${PEER_A}`]: () => gate.promise });
    axiosInstance.get.mockClear(); // count only the older-page requests below

    const first = S().loadOlderMessages(CONV_A);
    const second = await S().loadOlderMessages(CONV_A);

    expect(second).toEqual({ ok: false, error: "Already loading" });
    expect(S().historyByConversationId[CONV_A].isLoadingOlder).toBe(true);
    expect(S().historyByConversationId[CONV_B].isLoadingOlder).toBe(false);
    expect(axiosInstance.get).toHaveBeenCalledTimes(1);

    gate.resolve(page([msg(3)], pageInfo({ hasMore: false, nextCursor: null })));
    await first;
    expect(S().historyByConversationId[CONV_A].isLoadingOlder).toBe(false);
  });

  it("applies an older page to the conversation it was requested for, even after the selection moved", async () => {
    const gate = deferred();
    await loadFirstPages();
    mockRoutes({ [`/messages/${PEER_A}`]: () => gate.promise });
    const historyB = S().historyByConversationId[CONV_B];
    const bucketB = bucket(CONV_B);

    const pending = S().loadOlderMessages(CONV_A);
    S().setActiveConversationId(CONV_B); // user switches mid-request
    gate.resolve(page([msg(3), msg(4)], pageInfo({ hasMore: false, nextCursor: null })));
    await pending;

    expect(ids(CONV_A)).toEqual([oid(3), oid(4), oid(5), oid(6)]);
    expect(bucket(CONV_B)).toBe(bucketB);
    expect(S().historyByConversationId[CONV_B]).toBe(historyB);
    expect(S().activeConversationId).toBe(CONV_B);
  });

  it("does not let a stale older-page response overwrite a newer cursor", async () => {
    const gate = deferred();
    const FRESH_CURSOR = oid(0x99);
    let firstPage = page([msg(5), msg(6)], pageInfo({ nextCursor: CURSOR_A }));
    await loadFirstPages({ [`/messages/${PEER_A}`]: (config) => (config?.params ? gate.promise : firstPage) });

    const pending = S().loadOlderMessages(CONV_A); // captured CURSOR_A
    firstPage = page([msg(5), msg(6), msg(7)], pageInfo({ nextCursor: FRESH_CURSOR }));
    await S().getMessages(); // a fresh first load moves the cursor
    gate.resolve(page([msg(3), msg(4)], pageInfo({ hasMore: false, nextCursor: null })));
    await pending;

    expect(S().historyByConversationId[CONV_A]).toEqual({
      limit: 30, hasMore: true, nextCursor: FRESH_CURSOR, isLoadingOlder: false,
    });
    expect(ids(CONV_A)).toEqual([3, 4, 5, 6, 7].map(oid)); // messages still merged
  });
});

// ---------- 6. stale-snapshot / race regression -------------------------

describe("functional-updater race regression", () => {
  it("keeps a live message that arrives while a send is in flight", async () => {
    await seedConversations(CONV_A);
    const socket = connectFakeSocket();
    S().ingestMessages([msg(1)]);
    const gate = deferred();
    axiosInstance.post.mockReturnValue(gate.promise);

    const sending = S().sendMessage({ text: "mine" });
    socket.trigger("newMessage", msg(2)); // lands while the POST is pending
    gate.resolve({ data: mine(3) });
    await sending;

    // A handler working from a stale snapshot would have dropped m2.
    expect(ids(CONV_A)).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("keeps a live message that arrives while a history fetch is in flight", async () => {
    await seedConversations(CONV_A);
    const socket = connectFakeSocket();
    const gate = deferred();
    mockRoutes({ [`/messages/${PEER_A}`]: () => gate.promise });

    const loading = S().getMessages();
    socket.trigger("newMessage", msg(3)); // newer than the snapshot the server took
    gate.resolve(page([msg(1), msg(2)], pageInfo()));
    await loading;

    expect(ids(CONV_A)).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("does not let concurrent loads for two conversations clobber each other", async () => {
    await seedConversations(CONV_A);
    const gateA = deferred();
    const gateB = deferred();
    mockRoutes({
      [`/messages/${PEER_A}`]: () => gateA.promise,
      [`/messages/${PEER_B}`]: () => gateB.promise,
    });

    const loadA = S().getMessages(); // target resolved now: A
    S().setActiveConversationId(CONV_B);
    const loadB = S().getMessages(); // target resolved now: B

    gateB.resolve(page([msg(8, { conversationId: CONV_B, senderId: PEER_B })], pageInfo({ nextCursor: oid(0x60) })));
    await loadB;
    gateA.resolve(page([msg(1), msg(2)], pageInfo({ nextCursor: oid(0x61) })));
    await loadA;

    expect(ids(CONV_A)).toEqual([oid(1), oid(2)]);
    expect(ids(CONV_B)).toEqual([oid(8)]);
    expect(S().historyByConversationId[CONV_A].nextCursor).toBe(oid(0x61));
    expect(S().historyByConversationId[CONV_B].nextCursor).toBe(oid(0x60));
  });
});
