export interface GitIdentity {
  name: string;
  email: string;
  localName: string | null;
  localEmail: string | null;
}

/** A panel instance owns its draft; late reads/saves cannot mutate a replacement. */
export function createGitIdentityEditor(read: () => Promise<GitIdentity>, write: (name: string, email: string) => Promise<boolean>) {
  let identity = $state<GitIdentity | null>(null);
  let name = $state("");
  let email = $state("");
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  let disposed = false;
  let generation = 0;
  let edits = 0;

  async function load(): Promise<void> {
    if (disposed || loading || saving) return;
    const request = ++generation;
    const editVersion = edits;
    loading = true;
    error = null;
    try {
      const next = await read();
      if (disposed || request !== generation) return;
      identity = next;
      if (editVersion === edits) { name = next.name; email = next.email; }
    } catch (reason) {
      if (!disposed && request === generation) error = String(reason);
    } finally {
      if (!disposed && request === generation) loading = false;
    }
  }

  async function save(): Promise<void> {
    if (disposed || loading || saving || !name.trim() || !email.trim()) return;
    saving = true;
    saved = false;
    error = null;
    const submitted = { name: name.trim(), email: email.trim() };
    try {
      const ok = await write(submitted.name, submitted.email);
      if (disposed) return;
      if (ok) {
        saved = true;
        const next = await read();
        if (disposed) return;
        identity = next;
        name = next.name;
        email = next.email;
      } else error = "Could not save the commit author. See the Git error above and retry.";
    } catch (reason) {
      if (!disposed) error = saved ? `Saved, but could not reload Git settings: ${String(reason)}` : String(reason);
    } finally {
      if (!disposed) saving = false;
    }
  }

  return {
    get identity() { return identity; },
    get name() { return name; }, set name(value: string) { if (!saving) { name = value; edits++; saved = false; } },
    get email() { return email; }, set email(value: string) { if (!saving) { email = value; edits++; saved = false; } },
    get loading() { return loading; }, get saving() { return saving; }, get error() { return error; }, get saved() { return saved; },
    load, save,
    dispose() { disposed = true; generation++; },
  };
}
