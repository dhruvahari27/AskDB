export type LlmTask = 'draft' | 'classify' | 'explain' | 'simulate_user';

export interface LlmRequest {
  task: LlmTask;
  system: string;
  user: string;
  /** ask the provider for a JSON object reply */
  json: boolean;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cached?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** An error whose message is safe and useful to show the user. */
export class LlmError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}
