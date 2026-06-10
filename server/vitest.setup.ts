// Default env for tests. configs/config.ts validates these at import time
// (pulled in transitively by app.ts), so they must exist even on machines/CI
// without a populated server/.env. dotenv never overwrites existing values, so
// these take precedence over a local .env during test runs; individual tests
// that exercise the validators delete/override them as needed.
process.env.VISION_MODE = 'mock';
process.env.PLAUSIBILITY_MODE = 'mock';
process.env.S3_MODE = 'localstack';
process.env.S3_BUCKET_NAME = 'test-bucket';
process.env.ASSET_BASE_URL = 'http://assets.test/test-bucket';
process.env.APP_DEEP_LINK_SCHEME = 'exp+breadsheet';
