import { describe, expect, it } from "vitest";
import { gitCiSetupGuide, type GitCiSnapshot } from "./git-ci";

function setupSnapshot(
  provider: "github" | "gitlab",
  availability: "cliMissing" | "authRequired",
  host: string,
): GitCiSnapshot {
  return {
    provider,
    availability,
    host,
    headSha: "a".repeat(40),
    localOnly: false,
    runs: [],
  };
}

describe("Git CI setup guidance", () => {
  it("provides Homebrew install and host-scoped authentication for GitHub", () => {
    expect(gitCiSetupGuide(setupSnapshot("github", "cliMissing", "github.com"))).toMatchObject({
      providerLabel: "GitHub CLI",
      cliName: "gh",
      installCommand: "brew install gh",
      authCommand: "gh auth login --hostname 'github.com'",
      needsInstall: true,
    });
  });

  it("provides GitLab authentication without repeating installation when glab exists", () => {
    expect(gitCiSetupGuide(setupSnapshot("gitlab", "authRequired", "gitlab.example.com"))).toMatchObject({
      providerLabel: "GitLab CLI",
      cliName: "glab",
      installCommand: "brew install glab",
      authCommand: "glab auth login --hostname 'gitlab.example.com'",
      needsInstall: false,
    });
  });

  it("shell-quotes provider hosts before presenting an authentication command", () => {
    expect(gitCiSetupGuide(setupSnapshot("github", "authRequired", "github'oops.example"))?.authCommand)
      .toBe("gh auth login --hostname 'github'\\''oops.example'");
  });
});
