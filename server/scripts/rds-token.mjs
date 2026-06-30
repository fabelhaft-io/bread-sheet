/**
 * Mint a short-lived (15 min) RDS IAM auth token and print it to stdout.
 * Used by the ECS startup command to inject a token into DATABASE_URL before
 * running `prisma migrate deploy` (which reads the URL directly and cannot
 * use the pg.Pool async password callback).
 *
 * Requires: AWS_REGION, DB_HOST, DB_PORT (default 5432), DB_USER.
 */
import { Signer } from '@aws-sdk/rds-signer';

const hostname = process.env.DB_HOST;
const port = Number(process.env.DB_PORT || '5432');
const username = process.env.DB_USER;
const region = process.env.AWS_REGION;

if (!hostname || !username || !region) {
  process.stderr.write('rds-token: DB_HOST, DB_USER, and AWS_REGION are required\n');
  process.exit(1);
}

const signer = new Signer({ hostname, port, username, region });
const token = await signer.getAuthToken();
process.stdout.write(token);
