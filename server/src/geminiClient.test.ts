import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const constructorSpy = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    constructor(opts: unknown) {
      constructorSpy(opts);
    }
  }
  return { GoogleGenAI };
});

const GEMINI_ENV = [
  'GEMINI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
];

function clearEnv() {
  for (const key of GEMINI_ENV) delete process.env[key];
}

describe('getGeminiClient', () => {
  beforeEach(() => {
    constructorSpy.mockReset();
    vi.resetModules();
    clearEnv();
  });

  afterEach(clearEnv);

  it('uses the Gemini Developer API with GEMINI_API_KEY by default', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { getGeminiClient } = await import('./geminiClient.js');

    getGeminiClient();

    expect(constructorSpy).toHaveBeenCalledWith({ apiKey: 'test-key' });
  });

  it('throws when neither Vertex nor GEMINI_API_KEY is configured', async () => {
    const { getGeminiClient } = await import('./geminiClient.js');

    expect(() => getGeminiClient()).toThrow(/GEMINI_API_KEY/);
    expect(constructorSpy).not.toHaveBeenCalled();
  });

  it('uses Vertex AI (no API key) when GOOGLE_GENAI_USE_VERTEXAI=true', async () => {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    process.env.GOOGLE_CLOUD_PROJECT = 'breadsheet-prod';
    process.env.GOOGLE_CLOUD_LOCATION = 'europe-west1';
    const { getGeminiClient } = await import('./geminiClient.js');

    getGeminiClient();

    expect(constructorSpy).toHaveBeenCalledWith({
      vertexai: true,
      project: 'breadsheet-prod',
      location: 'europe-west1',
    });
  });

  it('throws when Vertex is enabled without project/location', async () => {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    const { getGeminiClient } = await import('./geminiClient.js');

    expect(() => getGeminiClient()).toThrow(/GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION/);
    expect(constructorSpy).not.toHaveBeenCalled();
  });

  it('caches the client across calls', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { getGeminiClient } = await import('./geminiClient.js');

    const a = getGeminiClient();
    const b = getGeminiClient();

    expect(a).toBe(b);
    expect(constructorSpy).toHaveBeenCalledTimes(1);
  });
});
