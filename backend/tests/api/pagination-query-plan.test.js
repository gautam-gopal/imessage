import { describe, it, expect, vi, afterEach } from "vitest";
import mongoose from "mongoose";
import Message from "../../src/models/message.model.js";
import { getMessagePage } from "../../src/lib/message-history.js";
import { createUser, createDirect } from "../helpers/factories.js";

afterEach(() => vi.restoreAllMocks());

// Runs the REAL getMessagePage, captures the Mongoose query it builds, then
// explains a clone of that exact query. The plan therefore belongs to the
// production query shape, not to a copy that could drift from it.
async function explainPage(args) {
  let captured;
  const realFind = Message.find.bind(Message);
  vi.spyOn(Message, "find").mockImplementation((...findArgs) => {
    captured = realFind(...findArgs);
    return captured;
  });

  const page = await getMessagePage(args);
  Message.find.mockRestore();

  const explain = await captured.clone().explain("executionStats");
  return { page, explain };
}

// Every plan-stage name anywhere in the winning plan tree, whichever server
// engine produced it (classic nests under inputStage, SBE under queryPlan).
function collectStages(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectStages(n, out));
  } else if (node && typeof node === "object") {
    if (typeof node.stage === "string") out.push(node.stage);
    for (const [key, value] of Object.entries(node)) {
      if (key !== "slotBasedPlan") collectStages(value, out);
    }
  }
  return out;
}

function collectIndexNames(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectIndexNames(n, out));
  } else if (node && typeof node === "object") {
    if (typeof node.indexName === "string") out.push(node.indexName);
    for (const [key, value] of Object.entries(node)) {
      if (key !== "slotBasedPlan") collectIndexNames(value, out);
    }
  }
  return out;
}

async function seed() {
  const [a, b, c] = [await createUser(), await createUser(), await createUser()];
  const target = await createDirect(a, b);
  const other = await createDirect(a, c);

  const now = Date.now();
  const doc = (conversationId, senderId, i) => ({
    conversationId,
    senderId,
    text: `m${i}`,
    createdAt: new Date(now + i),
    updatedAt: new Date(now + i),
  });

  // Enough volume, split across conversations, that a scan would be visibly
  // wrong: 3000 messages in the target, 3000 in a neighbour.
  await Message.insertMany(
    Array.from({ length: 3000 }, (_, i) => doc(target._id, a._id, i)),
  );
  await Message.insertMany(
    Array.from({ length: 3000 }, (_, i) => doc(other._id, a._id, i)),
  );

  return { target };
}

describe("Stage 6 pagination query plan", () => {
  it("declares the { conversationId: 1, _id: -1 } index", async () => {
    const indexes = await Message.collection.indexes();
    expect(indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ conversationId: 1, _id: -1 }))).toBe(true);
  });

  it("first page: IXSCAN on the conversation index, no scan, no in-memory sort, reads only limit+1 docs", async () => {
    const { target } = await seed();

    const { page, explain } = await explainPage({
      conversationId: target._id,
      before: undefined,
      limit: 30,
    });

    const stages = collectStages(explain.queryPlanner.winningPlan);
    expect(stages).toContain("IXSCAN");
    expect(stages).not.toContain("COLLSCAN");
    expect(stages).not.toContain("SORT"); // index order satisfies { _id: -1 }
    expect(collectIndexNames(explain.queryPlanner.winningPlan)).toContain(
      "conversationId_1__id_-1",
    );

    const stats = explain.executionStats;
    expect(stats.nReturned).toBe(31); // limit + 1 lookahead
    // Reads about one page of the 3000 in this conversation, never the set.
    expect(stats.totalDocsExamined).toBeLessThanOrEqual(40);
    expect(stats.totalKeysExamined).toBeLessThanOrEqual(40);
    expect(page.messages).toHaveLength(30);
  });

  it("cursor page: the before boundary is applied inside the index scan", async () => {
    const { target } = await seed();
    const newest = await Message.find({ conversationId: target._id })
      .sort({ _id: -1 })
      .skip(1000)
      .limit(1)
      .lean();
    const before = String(newest[0]._id);

    const { page, explain } = await explainPage({
      conversationId: target._id,
      before,
      limit: 30,
    });

    const stages = collectStages(explain.queryPlanner.winningPlan);
    expect(stages).toContain("IXSCAN");
    expect(stages).not.toContain("COLLSCAN");
    expect(stages).not.toContain("SORT");
    expect(collectIndexNames(explain.queryPlanner.winningPlan)).toContain(
      "conversationId_1__id_-1",
    );

    // Page 200 of the history costs the same as page 1: no skipping work.
    expect(explain.executionStats.totalDocsExamined).toBeLessThanOrEqual(40);
    expect(explain.executionStats.totalKeysExamined).toBeLessThanOrEqual(40);
    for (const m of page.messages) {
      expect(m._id.toString() < before).toBe(true);
      expect(String(m.conversationId)).toBe(String(target._id));
    }
  });

  it("sanity: the explain helper would flag a collection scan", async () => {
    await seed();
    const scan = await Message.find({ text: "m5" }).explain("executionStats");
    expect(collectStages(scan.queryPlanner.winningPlan)).toContain("COLLSCAN");
  });
});
