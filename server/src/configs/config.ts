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

// Gemini is used both for `llm` vision extraction and for `gemini` plausibility;
// either one being active requires the API key.
if (
  (visionMode === 'llm' || plausibilityMode === 'gemini') &&
  !process.env.GEMINI_API_KEY
) {
  throw new Error(
    'Missing required environment variable: GEMINI_API_KEY ' +
      '(required when VISION_MODE=llm or PLAUSIBILITY_MODE=gemini)',
  );
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