import { type LlmProvider, type LlmRequest, type LlmResponse } from './types';

/** Tries the primary provider; on any LlmError falls through to the secondary. */
export class FallbackProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private primary: LlmProvider,
    private secondary: LlmProvider,
  ) {
    this.name = `${primary.name}→${secondary.name}`;
    this.model = primary.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      return await this.primary.complete(req);
    } catch (e) {
      if ((e as Error).name === 'LlmError') {
        return this.secondary.complete(req);
      }
      throw e;
    }
  }
}
