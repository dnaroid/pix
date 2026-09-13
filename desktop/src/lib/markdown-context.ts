export interface MarkdownRenderOptions {
  /** Remote network images are opt-in so transcript rendering stays non-fetching. */
  remoteImages?: boolean;
  /** Add stable heading ids and render same-document hash links. */
  headingAnchors?: boolean;
}

export interface MarkdownRenderContext {
  readonly remoteImages: boolean;
  readonly headingAnchors: boolean;
  readonly headingSlugs: Map<string, number>;
}

export const DEFAULT_MARKDOWN_RENDER_CONTEXT: MarkdownRenderContext = {
  remoteImages: false,
  headingAnchors: false,
  headingSlugs: new Map(),
};

export function createMarkdownRenderContext(options: MarkdownRenderOptions): MarkdownRenderContext {
  return {
    remoteImages: options.remoteImages === true,
    headingAnchors: options.headingAnchors === true,
    headingSlugs: new Map(),
  };
}
