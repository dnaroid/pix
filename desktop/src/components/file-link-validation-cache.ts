export type FileLinkScope = "project" | "local";
export type FileLinkValidator = (path: string) => Promise<boolean>;

type CachedValidation = boolean | Promise<boolean>;

/**
 * Keeps lazy file-link checks stable while Markdown replaces its rendered DOM.
 * Entries are deliberately scoped to the validator identity: a project or local
 * root change supplies a new validator and therefore cannot reuse old results.
 */
export class FileLinkValidationCache {
  private readonly validators = new WeakMap<FileLinkValidator, Map<string, CachedValidation>>();

  peek(scope: FileLinkScope, path: string, validator: FileLinkValidator): CachedValidation | undefined {
    return this.validators.get(validator)?.get(this.key(scope, path));
  }

  validate(scope: FileLinkScope, path: string, validator: FileLinkValidator): CachedValidation {
    const key = this.key(scope, path);
    let entries = this.validators.get(validator);
    if (!entries) {
      entries = new Map();
      this.validators.set(validator, entries);
    }
    const cached = entries.get(key);
    if (cached !== undefined) return cached;

    const pending = Promise.resolve().then(() => validator(path));
    entries.set(key, pending);
    void pending.then(
      (exists) => {
        if (entries.get(key) === pending) entries.set(key, exists);
      },
      () => {
        // A transient filesystem failure must be retried on a later render.
        if (entries.get(key) === pending) entries.delete(key);
      },
    );
    return pending;
  }

  private key(scope: FileLinkScope, path: string): string {
    return `${scope}:${path}`;
  }
}
