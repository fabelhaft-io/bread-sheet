import { PrismaClient } from './generated/prisma_client/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { buildDatabaseConfig } from './configs/databaseConfig.js';

const { connectionString, host, port, user, database, ssl, password } = buildDatabaseConfig();

// `connectionString` and `password` are mutually exclusive in `pg`: it merges them as
// `Object.assign({}, config, parse(config.connectionString))`, so the parsed URL wins and
// its (always-present) `password` key overwrites an async callback passed alongside it.
// IAM auth therefore connects via discrete fields — see databaseConfig.ts.
const pool = new Pool({
  ...(connectionString !== undefined ? { connectionString } : { host, port, user, database }),
  ssl,
  ...(password && { password }),
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});

export default prisma;