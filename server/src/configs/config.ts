import dotenv from 'dotenv';

dotenv.config();

const VALID_VISION_MODES = ['mock', 'live', 'llm'] as const;
type VisionMode = (typeof VALID_VISION_MODES)[number];

function readVisionMode(): VisionMode {
  const m = process.env.VISION_MODE;
  if (!m) {
    throw new Error(
      'Missing required environment variable: VISION_MODE. Valid values: mock | live | llm',
    );
  }
  if (!VALID_VISION_MODES.includes(m as VisionMode)) {
    throw new Error(
      `Invalid VISION_MODE "${m}". Must be one of: ${VALID_VISION_MODES.join(' | ')}`,
    );
  }
  return m as VisionMode;
}

const VALID_PLAUSIBILITY_MODES = ['mock', 'gemini'] as const;
type PlausibilityMode = (typeof VALID_PLAUSIBILITY_MODES)[number];

function readPlausibilityMode(): PlausibilityMode {
  const m = process.env.PLAUSIBILITY_MODE;
  if (!m) {
    throw new Error(
      'Missing required environment variable: PLAUSIBILITY_MODE. Valid values: mock | gemini',
    );
  }
  if (!VALID_PLAUSIBILITY_MODES.includes(m as PlausibilityMode)) {
    throw new Error(
      `Invalid PLAUSIBILITY_MODE "${m}". Must be one of: ${VALID_PLAUSIBILITY_MODES.join(' | ')}`,
    );
  }
  return m as PlausibilityMode;
}

const VALID_S3_MODES = ['localstack', 'aws'] as const;
type S3Mode = (typeof VALID_S3_MODES)[number];

// Which S3 backend the server talks to. `localstack` switches the SDK to
// path-style addressing — LocalStack's bucket-prefixed (virtual-hosted-style)
// hostnames don't resolve inside the Docker network.
function readS3Mode(): S3Mode {
  const m = process.env.S3_MODE;
  if (!m) {
    throw new Error(
      'Missing required environment variable: S3_MODE. Valid values: localstack | aws',
    );
  }
  if (!VALID_S3_MODES.includes(m as S3Mode)) {
    throw new Error(`Invalid S3_MODE "${m}". Must be one of: ${VALID_S3_MODES.join(' | ')}`);
  }
  return m as S3Mode;
}

// Public base URL under which stored S3 object keys resolve. Includes the
// bucket part, so the path-style (LocalStack) vs virtual-hosted (AWS) URL
// difference is absorbed by the value, never by code:
//   - LocalStack:  http://<host-reachable-ip>:4566/breadsheet-images-local
//   - AWS:         https://<bucket>.s3.<region>.amazonaws.com  (or a CDN domain)
// Image URLs are assembled at READ time as `${assetBaseUrl}/${key}` — only
// keys are persisted, so changing this value never requires a data migration.
function readAssetBaseUrl(): string {
  const v = process.env.ASSET_BASE_URL;
  if (!v) {
    throw new Error(
      'Missing required environment variable: ASSET_BASE_URL ' +
        '(public base URL for stored image keys, e.g. ' +
        'http://192.168.1.10:4566/breadsheet-images-local for LocalStack or ' +
        'https://<bucket>.s3.<region>.amazonaws.com for AWS)',
    );
  }
  if (!/^https?:\/\//.test(v)) {
    throw new Error(`Invalid ASSET_BASE_URL "${v}". Must start with http:// or https://`);
  }
  return v.replace(/\/+$/, ''); // tolerate a trailing slash
}

function readS3BucketName(): string {
  const v = process.env.S3_BUCKET_NAME;
  if (!v) {
    throw new Error('Missing required environment variable: S3_BUCKET_NAME');
  }
  return v;
}

// The Supabase project every Bearer token is verified against (authMiddleware's
// `auth.getUser`). On dev both come from SSM (`/breadsheet/dev/SUPABASE_*`, see
// infrastructure.md § Hosted Supabase project). Missing used to fall through to
// `createClient('', '')`, which only failed with supabase-js's own
// "supabaseUrl is required." — this names the variable instead.
function readSupabaseUrl(): string {
  const v = process.env.SUPABASE_URL;
  if (!v) {
    throw new Error(
      'Missing required environment variable: SUPABASE_URL ' +
        '(the Supabase project URL, e.g. https://<project-ref>.supabase.co, ' +
        'or http://127.0.0.1:54321 for a local `supabase start` stack)',
    );
  }
  if (!/^https?:\/\//.test(v)) {
    throw new Error(`Invalid SUPABASE_URL "${v}". Must start with http:// or https://`);
  }
  return v;
}

function readSupabasePublishableKey(): string {
  const v = process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY;
  if (!v) {
    throw new Error(
      'Missing required environment variable: SUPABASE_PUBLISHABLE_DEFAULT_KEY ' +
        "(the Supabase project's publishable key, sb_publishable_…)",
    );
  }
  return v;
}

interface Config {
  port: number;
  nodeEnv: string;
  visionMode: VisionMode;
  plausibilityMode: PlausibilityMode;
  s3Mode: S3Mode;
  s3BucketName: string;
  assetBaseUrl: string;
  appDeepLinkScheme: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  geminiDailyCallCap: number | null;
  originVerifySecret: string | null;
}

const visionMode = readVisionMode();
const plausibilityMode = readPlausibilityMode();
const s3Mode = readS3Mode();

// Gemini is used both for `llm` vision extraction and for `gemini` plausibility.
// Either one being active requires credentials, chosen by environment
const geminiNeeded = visionMode === 'llm' || plausibilityMode === 'gemini';
if (geminiNeeded) {
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    if (!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GOOGLE_CLOUD_LOCATION) {
      throw new Error(
        'GOOGLE_GENAI_USE_VERTEXAI=true requires GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION',
      );
    }
  } else if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'Missing required environment variable: GEMINI_API_KEY ' +
        '(required when VISION_MODE=llm or PLAUSIBILITY_MODE=gemini, ' +
        'unless GOOGLE_GENAI_USE_VERTEXAI=true)',
    );
  }
}

function readGeminiDailyCallCap(required: boolean): number | null {
  const v = process.env.GEMINI_DAILY_CALL_CAP;
  if (!required && v === undefined) return null;
  if (!v) {
    throw new Error(
      'Missing required environment variable: GEMINI_DAILY_CALL_CAP ' +
        '(required when VISION_MODE=llm or PLAUSIBILITY_MODE=gemini; a positive integer)',
    );
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid GEMINI_DAILY_CALL_CAP "${v}". Must be a positive integer.`);
  }
  return n;
}

const geminiDailyCallCap = readGeminiDailyCallCap(geminiNeeded);

const appDeepLinkScheme = process.env.APP_DEEP_LINK_SCHEME;
if (!appDeepLinkScheme) {
  throw new Error(
    'Missing required environment variable: APP_DEEP_LINK_SCHEME ' +
    '(e.g. exp+breadsheet for Expo Go, breadsheet for production)',
  );
}

const config: Config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  visionMode,
  plausibilityMode,
  s3Mode,
  s3BucketName: readS3BucketName(),
  assetBaseUrl: readAssetBaseUrl(),
  appDeepLinkScheme,
  supabaseUrl: readSupabaseUrl(),
  supabasePublishableKey: readSupabasePublishableKey(),
  geminiDailyCallCap,
  originVerifySecret: process.env.ORIGIN_VERIFY_SECRET || null,
};

export default config;