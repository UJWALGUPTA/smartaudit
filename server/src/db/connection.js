import fs from 'node:fs';
import mongoose from 'mongoose';
import config from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('db');
let embedded = null;

async function isReachable(uri) {
  const probe = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 800 });
  try {
    await probe.asPromise();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

/**
 * MONGO_URI wins. Otherwise reuse an embedded mongod that another process
 * (e.g. `npm run dev`) already started, or boot one ourselves. The embedded
 * instance persists to ./.data/db so `npm run seed` and `npm run dev` share data.
 */
async function resolveUri() {
  if (config.mongoUri) return config.mongoUri;
  if (process.env.VERCEL) throw new Error('MONGO_URI must be set when running on Vercel (no embedded MongoDB there)');

  const { port, dbPath, dbName } = config.embeddedMongo;
  const uri = `mongodb://127.0.0.1:${port}/${dbName}`;
  if (await isReachable(uri)) {
    log.info(`using embedded MongoDB already running on :${port}`);
    return uri;
  }

  log.info(`MONGO_URI not set - starting embedded MongoDB on :${port} (data: .data/db)`);
  fs.mkdirSync(dbPath, { recursive: true });
  const { MongoMemoryServer } = await import('mongodb-memory-server-core');
  embedded = await MongoMemoryServer.create({
    instance: { port, dbPath, dbName, storageEngine: 'wiredTiger' },
  });
  return uri;
}

export async function connectDatabase() {
  const uri = await resolveUri();
  // Small pool: serverless instances are many and short-lived.
  await mongoose.connect(uri, { maxPoolSize: process.env.VERCEL ? 5 : 20, serverSelectionTimeoutMS: 10_000 });
  log.info(`connected to ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
  if (embedded) {
    await embedded.stop({ doCleanup: false });
    embedded = null;
  }
}
