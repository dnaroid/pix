import { describe, expect, it, vi } from "vitest";
import { createProjectGitRemoteLink, gitRemoteLinkLabel, type GitRemoteEntryLink } from "./project-git-remote-link";
import { projectExplorerMenuActions } from "./project-explorer-native-menu";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const github: GitRemoteEntryLink = { provider: "github", url: "https://github.com/o/r/blob/main/a.ts" };

describe("Project Explorer remote link", () => {
  it("labels providers", () => {
    expect(gitRemoteLinkLabel("github")).toBe("Open on GitHub");
    expect(gitRemoteLinkLabel("gitlab")).toBe("Open on GitLab");
  });

  it("binds the published link to its workspace and path, including the root", async () => {
    const publish = vi.fn();
    const links = createProjectGitRemoteLink(vi.fn().mockResolvedValue(github), publish);
    await links.request("/w", "");
    expect(publish).toHaveBeenLastCalledWith({ ...github, workspace: "/w", path: "" });
  });

  it("never publishes a stale lookup after a newer target or invalidation", async () => {
    const first = deferred<GitRemoteEntryLink | null>();
    const second = deferred<GitRemoteEntryLink | null>();
    const resolve = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const publish = vi.fn();
    const links = createProjectGitRemoteLink(resolve, publish);
    const a = links.request("/w", "a.ts");
    const b = links.request("/w", "b.ts");
    first.resolve(github);
    await a;
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ path: "a.ts" }));
    links.invalidate();
    second.resolve(github);
    await b;
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ path: "b.ts" }));
  });

  it("hides the command when lookup fails or no target is open", async () => {
    const publish = vi.fn();
    const links = createProjectGitRemoteLink(vi.fn().mockRejectedValue(new Error("not a repo")), publish);
    await links.request("/w", "a.ts");
    expect(publish).toHaveBeenLastCalledWith(null);
    await links.request("/w", null);
    expect(publish).toHaveBeenLastCalledWith(null);
  });

  it("maps provider labels to a stable native id distinct from external editors", () => {
    const action = vi.fn();
    const ids = projectExplorerMenuActions(
      [{ label: "Open on GitHub" }, { label: "Open on GitLab" }, { label: "Open in Editor" }],
      { "Open on GitHub": action, "Open on GitLab": action, "Open in Editor": action }, "Reveal in Finder", false,
    ).map(({ id }) => id);
    expect(ids).toEqual(["remote", "remote", "external"]);
  });
});
