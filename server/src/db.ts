import { PrismaClient } from './generated/prisma_client/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { buildDatabaseConfig } from './configs/databaseConfig.js';

const { connectionString, ssl, password } = buildDatabaseConfig();

const pool = new Pool({ connectionString, ssl, ...(password && { password }) });

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});

export default prisma;