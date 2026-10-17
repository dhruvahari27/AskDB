import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './types';
import { postJson } from './http';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  constructor(private apiKey: string, readonly model: string) {
    if (!apiKey) throw new LlmError('GEMINI_API_KEY is not set. Add it to .env (free key at https://aistudio.google.com) or use LLM_PROVIDER=mock.');
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const data = await postJson<GeminiResponse>({
      providerName: 'Gemini',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          temperature: req.temperature ?? 0,
          ...(req.json ? { responseMimeType: 'application/json' } : {}),
        },
      },
    });
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new LlmError('Gemini returned an empty reply.');
    return {
      text,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}
