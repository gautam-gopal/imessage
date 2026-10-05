import { describe, it, expect, vi, afterEach } from "vitest";
import Message from "../../src/models/message.model.js";
import {
  UNREAD_COUNT_CAP,
  advanceReadWatermark,
  getUnreadCounts,
} from "../../src/lib/unread.js";
import { createUser, createDirect } from "../helpers/factories.js";

afterEach(() => vi.restoreAllMocks());

// Runs the REAL getUnreadCounts, captures the aggregation pipeline it builds,
// then explains that exact pipeline, so the plan belongs to the production
// query shape rather than a copy that could drift from it.
async function explainUnread({ userId, conversationId }) {
  let pipeline;
  const realAggregate = Message.aggregate.bind(Message);
  vi.spyOn(Message, "aggregate").mockImplementation((p, ...rest) => {
    pipeline = p;
    return realAggregate(p, ...rest);
  });

  const counts = await getUnreadCounts({
    userId,
    conversationIds: [conversationId],
  });
  Message.aggregate.mockRestore();

  const explain = await Message.aggregate(pipeline).explain("executionStats");
  return { counts, explain };
}

// An aggregation explain is either top-level { queryPlanner, executionStats }
// or nested under stages[].$cursor, depending on the server. Find the part
// that carries the query plan.
function findPlanHolder(node) {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findPlanHolder(n);
      if (found) return found;
    }
  } else if (node && typeof node === "object") {
    if (node.queryPlanner && node.executionStats) return node;
    for (const value of Object.values(node)) {
      const found = findPlanHolder(value);
      if (found) return found;
    }
  }
  return null;
}

function collect(node, key, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, key, out));
  } else if (node && typeof node === "object") {
    if (typeof node[key] === "string") out.push(node[key]);
    for (const [k, value] of Object.entries(node)) {
      if (k !== "slotBasedPlan") collect(value, key, out);
    }
  }
  return out;
}

async function seed() {
  const [a, b, c] = [
    await createUser(),
    await createUser(),
    await createUser(),
  ];
  const target = await createDirect(a, b);
  const other = await createDirect(a, c);

  const now = Date.now();
  const doc = (conversationId, i) => ({
    conversationId,
    senderId: a._id,
    text: `m${i}`,
    createdAt: new Date(now + i),
    updatedAt: new Date(now + i),
  });

  await Message.insertMany(
    Array.from({ length: 3000 }, (_, i) => doc(target._id, i)),
  );
  await Message.insertMany(
    Array.from({ length: 3000 }, (_, i) => doc(other._id, i)),
  );

  return { a, b, target };
}

function expectIndexedRangeScan(
  explain,
  { requireConversationIndex = true } = {},
) {
  const holder = findPlanHolder(explain);
  expect(holder).not.toBeNull();

  const stages = collect(holder.queryPlanner.winningPlan, "stage");
  expect(stages).toContain("IXSCAN");
  expect(stages).not.toContain("COLLSCAN");

  const indexNames = collect(holder.queryPlanner.winningPlan, "indexName");
  if (requireConversationIndex) {
    expect(indexNames).toContain("conversationId_1__id_-1");
  }
  return { stats: holder.executionStats, indexNames };
}

describe("Stage 10 unread count query plan", () => {
  it("no watermark: IXSCAN on the conversation index and the scan stops at the cap", async () => {
    const { b, target } = await seed();

    const { counts, explain } = await explainUnread({
      userId: b._id,
      conversationId: target._id,
    });

    const { stats } = expectIndexedRangeScan(explain);
    expect(counts[String(target._id)]).toBe(UNREAD_COUNT_CAP);
    // 3000 unread exist; the cap bounds the work to about the cap.
    expect(stats.totalDocsExamined).toBeLessThanOrEqual(UNREAD_COUNT_CAP + 10);
  });

  it("with a watermark: only the range after it is examined", async () => {
    const { b, target } = await seed();
    const newest = await Message.find({ conversationId: target._id })
      .sort({ _id: -1 })
      .skip(4)
      .limit(1)
      .lean();
    await advanceReadWatermark({
      userId: b._id,
      conversationId: target._id,
      messageId: newest[0]._id,
    });

    const { counts, explain } = await explainUnread({
      userId: b._id,
      conversationId: target._id,
    });

    const { stats } = expectIndexedRangeScan(explain);
    expect(counts[String(target._id)]).toBe(4);
    expect(stats.totalDocsExamined).toBeLessThanOrEqual(20);
    expect(stats.totalKeysExamined).toBeLessThanOrEqual(20);
  });

  it("known worst case, measured: a sender with no watermark scans their own messages", async () => {
    const { a, target } = await seed();

    const { counts, explain } = await explainUnread({
      userId: a._id,
      conversationId: target._id,
    });

    // Informational: the planner may legitimately choose a different index
    // here (the user is the only sender, so a senderId-keyed index can end
    // immediately). Gate only on "an index scan, never a collection scan".
    const { stats, indexNames } = expectIndexedRangeScan(explain, {
      requireConversationIndex: false,
    });
    expect(counts[String(target._id)]).toBe(0);
    console.info(
      `[unread plan] sender-without-watermark index=${indexNames.join(",")} docsExamined=${stats.totalDocsExamined} keysExamined=${stats.totalKeysExamined}`,
    );
  });

  it("sanity: the helper would flag a collection scan", async () => {
    await seed();
    const scan = await Message.aggregate([{ $match: { text: "m5" } }]).explain(
      "executionStats",
    );
    const holder = findPlanHolder(scan);
    expect(collect(holder.queryPlanner.winningPlan, "stage")).toContain(
      "COLLSCAN",
    );
  });
});
