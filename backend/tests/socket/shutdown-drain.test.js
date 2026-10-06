import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import User from "../../src/models/user.model.js";
import { drainPendingWrites } from "../../src/lib/socket.js";
import { createUser } from "../helpers/factories.js";
import {
  startSocketServer,
  stopSocketServer,
  disconnectAll,
  connectAs,
  waitFor,
} from "../helpers/socket-client.js";

beforeAll(startSocketServer);
afterAll(stopSocketServer);
afterEach(async () => {
  vi.restoreAllMocks();
  await disconnectAll();
});

describe("draining disconnect writes before shutdown", () => {
  it("drainPendingWrites waits for the lastSeenAt write a disconnect started", async () => {
    const user = await createUser();
    let finished = false;

    const spy = vi.spyOn(User, "updateOne").mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve({});
          }, 100),
        ),
    );

    const client = await connectAs(user);
    client.disconnect();
    await waitFor(
      () => spy.mock.calls.some(([, update]) => update?.$set?.lastSeenAt),
      { label: "disconnect started its lastSeenAt write" },
    );

    expect(finished).toBe(false); // write still in flight
    await drainPendingWrites();
    expect(finished).toBe(true); // drain waited for it
  });

  it("resolves immediately when nothing is pending", async () => {
    await expect(drainPendingWrites()).resolves.toBeUndefined();
  });
});
