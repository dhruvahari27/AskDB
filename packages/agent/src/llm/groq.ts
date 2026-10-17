import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './types';
import { postJson } from './http';

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Groq exposes an OpenAI-compatible endpoint. Any OpenAI-compatible server works by changing baseUrl. */
export class GroqProvider implements LlmProvider {
  readonly name = 'groq';
  constructor(
    private apiKey: string,
    readonly model: string,
    private baseUrl = 'https://api.groq.com/openai/v1',
  ) {
    if (!apiKey) throw new LlmError('GROQ_API_KEY is not set. Add it to .env (free key at https://console.groq.com) or use LLM_PROVIDER=mock.');
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const data = await postJson<ChatResponse>({
      providerName: 'Groq',
      url: `${this.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        temperature: req.temperature ?? 0,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      },
    });
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new LlmError('Groq returned an empty reply.');
    return { text, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 };
  }
}
