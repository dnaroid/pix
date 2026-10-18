import { invoke } from "@tauri-apps/api/core";

export async function completeDesktopOnboarding(): Promise<void> {
  await invoke("desktop_onboarding_status", { complete: true });
}

export async function desktopOnboardingCompleted(): Promise<boolean> {
  return invoke<boolean>("desktop_onboarding_status", { complete: false });
}
