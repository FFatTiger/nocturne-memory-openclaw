import { Pool } from 'pg';

function normalizeDatabaseUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (value.startsWith('postgresql+asyncpg://')) {
    return `postgresql://${value.slice('postgresql+asyncpg://'.length)}`;
  }
  if (value.startsWith('postgresql://') || value.startsWith('postgres://')) {
    return value;
  }
  if (value.startsWith('postgresql+')) {
    const [, rest = ''] = value.split('://', 2);
    return `postgresql://${rest}`;
  }
  return value;
}

function buildSslConfig(connectionString) {
  try {
    const url = new URL(connectionString);
    const host = (url.hostname || '').toLowerCase();
    const sslMode = (url.searchParams.get('sslmode') || url.searchParams.get('ssl') || '').toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres';
    const sslDisabled = ['disable', 'false', 'off', '0', 'no'].includes(sslMode);
    if (isLocal || sslDisabled) return false;
    return { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

function getPool() {
  if (globalThis.__nocturnePgPool) {
    return globalThis.__nocturnePgPool;
  }

  const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the Next.js server API.');
  }

  const pool = new Pool({
    connectionString,
    ssl: buildSslConfig(connectionString),
    max: Number(process.env.NOCTURNE_DB_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  globalThis.__nocturnePgPool = pool;
  return pool;
}

export { getPool };

export async function sql(text, params = []) {
  return getPool().query(text, params);
}
