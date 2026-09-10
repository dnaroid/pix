import { describe, expect, it } from "vitest";
import {
  appendTerminalOutput,
  filterPackageScripts,
  packageManagerRunLabel,
  packageTerminalStatusLabel,
} from "./package-scripts";

describe("package scripts helpers", () => {
  it("filters scripts by name and command", () => {
    const scripts = [
      { name: "dev", command: "vite" },
      { name: "test", command: "vitest run" },
    ];
    expect(filterPackageScripts(scripts, "dev").map((script) => script.name)).toEqual(["dev"]);
    expect(filterPackageScripts(scripts, "vitest").map((script) => script.name)).toEqual(["test"]);
  });

  it("formats run and terminal status labels", () => {
    expect(packageManagerRunLabel("pnpm", "dev")).toBe("pnpm run dev");
    expect(packageTerminalStatusLabel({ status: "running" })).toBe("Running");
    expect(packageTerminalStatusLabel({ status: "exited", exitCode: 2 })).toBe("Exited · 2");
  });

  it("bounds retained terminal output", () => {
    expect(appendTerminalOutput("abc", "def", 5)).toBe("bcdef");
  });
});
