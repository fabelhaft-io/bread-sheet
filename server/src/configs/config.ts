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

interface Config {
  port: number;
  nodeEnv: string;
  visionMode: VisionMode;
  plausibilityMode: PlausibilityMode;
  appDeepLinkScheme: string;
}

const visionMode = readVisionMode();
const plausibilityMode = readPlausibilityMode();

// Gemini is used both for `llm` vision extraction and for `gemini` plausibility.
// Either one being active requires credentials, chosen by environment (see
// services/geminiClient.ts): Vertex AI via ADC/Workload Identity Federation when
// GOOGLE_GENAI_USE_VERTEXAI=true (keyless, used in prod), otherwise the Gemini
// Developer API with GEMINI_API_KEY (the local default).
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
  appDeepLinkScheme,
};

export default config;