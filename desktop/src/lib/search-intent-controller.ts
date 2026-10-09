import type { SearchIntentResponse } from "../../../acp/src/search/contract";

/** Cancels and invalidates late Jev classifications on edits, close or workspace changes. */
export class SearchIntentController {
  private owner?: AbortController;
  private generation = 0;

  async classify(request: (signal: AbortSignal) => Promise<SearchIntentResponse>): Promise<SearchIntentResponse | undefined> {
    this.cancel();
    const generation = this.generation;
    const owner = new AbortController();
    this.owner = owner;
    try {
      const response = await request(owner.signal);
      if (owner.signal.aborted || this.generation !== generation) return undefined;
      return response;
    } catch {
      if (owner.signal.aborted || this.generation !== generation) return undefined;
      return { intent: "search", fallback: true };
    } finally {
      if (this.owner === owner) this.owner = undefined;
    }
  }

  cancel(): void {
    this.generation++;
    this.owner?.abort();
    this.owner = undefined;
  }
}
