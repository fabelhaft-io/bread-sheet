import { PrismaClient } from './generated/prisma_client/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { buildDatabaseConfig } from './configs/databaseConfig.js';

// The runtime DB connection goes through the pg driver adapter, which does its own
// TLS — independent of the URL's `sslmode` and of the Prisma migration engine.
// buildDatabaseConfig validates DB_SSL and (for RDS) verifies the server cert
// against the shipped CA bundle. See configs/databaseConfig.ts for the full why.
const { connectionString, ssl } = buildDatabaseConfig();

const pool = new Pool({ connectionString, ssl });

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});

export default prisma;