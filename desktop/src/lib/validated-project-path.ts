import type { ProjectPathKind, ProjectPathNavigation } from "./project-path-navigation";

export function createValidatedProjectPath(
  path: string,
  kind: ProjectPathKind,
  navigation: ProjectPathNavigation,
  setValid: (valid: boolean) => void,
  onNavigate: () => void,
) {
  let disposed = false;
  let navigating = false;
  let generation = 0;

  async function validate(): Promise<boolean> {
    if (disposed) return false;
    const request = ++generation;
    let exists = false;
    try { exists = await navigation.validate(path, kind); } catch { /* Missing or inaccessible paths remain plain text. */ }
    if (disposed || request !== generation) return false;
    setValid(exists);
    return exists;
  }

  async function open(): Promise<void> {
    if (disposed || navigating) return;
    navigating = true;
    try {
      if (!await validate()) return;
      // Closing the dialog disposes this controller; ownership guards live in navigation.
      onNavigate();
      await navigation.open(path);
    } catch {
      if (!disposed) setValid(false);
    } finally {
      navigating = false;
    }
  }

  return { validate, open, dispose: () => { disposed = true; generation++; } };
}
