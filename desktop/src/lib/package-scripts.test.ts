import { describe, expect, it } from "vitest";
import {
  appendTerminalOutput,
  filterPackageScripts,
  packageManagerRunLabel,
  packageTerminalStatusLabel,
} from "./package-scripts";

describe("package scripts helpers", () => {
  it("filters scripts by name only for the compact list", () => {
    const scripts = [
      { name: "dev", command: "vite" },
      { name: "test", command: "vitest run" },
    ];
    expect(filterPackageScripts(scripts, "dev").map((script) => script.name)).toEqual(["dev"]);
    expect(filterPackageScripts(scripts, "vitest")).toEqual([]);
  });

  it("formats run and terminal status labels", () => {
    expect(packageManagerRunLabel("pnpm", "dev")).toBe("pnpm run dev");
    expect(packageTerminalStatusLabel({ status: "running" })).toBe("Running");
    expect(packageTerminalStatusLabel({ status: "exited", exitCode: 2 })).toBe("Exited · 2");
  });

  it("bounds retained terminal output", () => {
    expect(appendTerminalOutput("abc", "def", 5)).toBe("bcdef");
  });

  it("preserves ANSI escape sequences for xterm instead of flattening terminal colors", () => {
    const colored = "\u001b[31mred\u001b[0m";
    expect(appendTerminalOutput("", colored)).toBe(colored);
  });
});
