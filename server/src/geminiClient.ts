import { GoogleGenAI } from '@google/genai';

let _client: GoogleGenAI | null = null;

/**
 * Single Gemini client shared by every service that talks to Gemini
 * (image plausibility + LLM label extraction). The authentication method is
 * chosen by environment, never by calling code, so the Gemini-calling services
 * run byte-for-byte identically in local dev and production:
 *
 *   - `GOOGLE_GENAI_USE_VERTEXAI=true` → Vertex AI via Application Default
 *     Credentials. In production ADC resolves through Workload Identity
 *     Federation (keyless); no `GEMINI_API_KEY` is needed. Requires
 *     `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`.
 *   - otherwise → Gemini Developer API with `GEMINI_API_KEY` (local default).
 *
 * The required-variable combinations are validated at startup in
 * `configs/config.ts`; the checks here are the runtime fail-fast safety net
 * (and what the unit tests exercise, since they bypass config.ts).
 */
export function getGeminiClient(): GoogleGenAI {
  if (_client) return _client;

  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION;
    if (!project || !location) {
      throw new Error(
        'GOOGLE_GENAI_USE_VERTEXAI=true requires GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION',
      );
    }
    _client = new GoogleGenAI({ vertexai: true, project, location });
    return _client;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing required environment variable: GEMINI_API_KEY ' +
        '(required when VISION_MODE=llm or PLAUSIBILITY_MODE=gemini, ' +
        'unless GOOGLE_GENAI_USE_VERTEXAI=true)',
    );
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}
