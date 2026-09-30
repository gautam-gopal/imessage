import { MongoMemoryServer } from "mongodb-memory-server";

// One in-memory mongod for the whole run. Each test file gets its own
// database on it (see setup-file.js), so files stay isolated and the
// production/dev database is never touched.
export default async function setup(project) {
  const mongod = await MongoMemoryServer.create();
  project.provide("mongoUri", mongod.getUri());

  return async () => {
    await mongod.stop();
  };
}
