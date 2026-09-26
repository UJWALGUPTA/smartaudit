import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '../../..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const str = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const int = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const num = (name, fallback) => {
  const n = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name, fallback) => {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

const config = Object.freeze({
  port: int('API_PORT', 4000),
  mongoUri: str('MONGO_URI'),
  embeddedMongo: {
    port: int('EMBEDDED_MONGO_PORT', 27018),
    dbPath: path.join(ROOT_DIR, '.data', 'db'),
    dbName: 'smartaudit',
  },
  defaultTenantId: str('DEFAULT_TENANT_ID', '66a0c0ffee00000000000001'),

  ai: {
    mock: bool('MOCK_AI', true),
    openaiApiKey: str('OPENAI_API_KEY'),
    openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    openaiModel: str('OPENAI_MODEL', 'gpt-4o-mini'),
    openaiEmbeddingModel: str('OPENAI_EMBEDDING_MODEL'),
    maxRpm: int('AI_MAX_RPM', 60),
    requestTimeoutMs: int('AI_REQUEST_TIMEOUT_MS', 15000),
    fallbackToMock: bool('AI_FALLBACK_TO_MOCK', true),
    mockDelayMs: int('MOCK_AI_DELAY_MS', 400),
    mockFailureRate: num('MOCK_AI_FAILURE_RATE', 0),
  },

  worker: {
    concurrency: int('WORKER_CONCURRENCY', 2),
    pollIntervalMs: int('WORKER_POLL_INTERVAL_MS', 1000),
    leaseMs: int('WORKER_LEASE_MS', 60000),
    maxAttempts: int('WORKER_MAX_ATTEMPTS', 4),
    backoffBaseMs: int('WORKER_BACKOFF_BASE_MS', 2000),
  },
});

export default config;
