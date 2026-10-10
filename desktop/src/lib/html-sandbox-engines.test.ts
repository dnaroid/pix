import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Node vm import in Vitest runner (frontend tsconfig omits Node globals)
import { runInNewContext } from "node:vm";
import { extractSandboxEngines, loadSandboxEngine } from "./html-sandbox-engines";
import { MAX_SANDBOX_SOURCE_CHARS, prepareHtmlSandbox } from "./html-sandbox";

const fakeUrl = "data:text/javascript;base64,dGVzdA==";

describe("offline sandbox engines", () => {
  it("loads only declared allowlisted engines, once, ahead of authored scripts", async () => {
    const loader = vi.fn(async () => fakeUrl);
    const plain = await prepareHtmlSandbox("<p>No engine</p>", loader);
    expect(loader).not.toHaveBeenCalled();
    const source = '<script src="pix:three"></script><script src="pix:phaser"></script>'
      + '<script src="pix:three"></script><script>window.demo = THREE.REVISION;</script>';
    const prepared = await prepareHtmlSandbox(source, loader);
    expect(loader.mock.calls).toEqual([["three"], ["phaser"]]);
    expect(prepared.srcdoc).not.toContain("pix:three");
    expect(prepared.srcdoc.match(/base64,dGVzdA==/g)).toHaveLength(2);
    expect(prepared.srcdoc.indexOf(fakeUrl)).toBeLessThan(prepared.srcdoc.indexOf("window.demo"));
    const csp = (s: string) => s.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
    expect(csp(prepared.srcdoc)).toBe(csp(plain.srcdoc));
    expect(csp(prepared.srcdoc)).not.toMatch(/unsafe-eval|https:/);
  });

  it("rejects unknown markers, nonempty declarations, invalid bundles and oversize before loading", async () => {
    const loader = vi.fn(async () => fakeUrl);
    await expect(prepareHtmlSandbox('<script src="pix:remote"></script>', loader)).rejects.toThrow("Unknown sandbox engine");
    await expect(prepareHtmlSandbox('<script src="pix:three">alert(1)</script>', loader)).rejects.toThrow("must be empty");
    await expect(prepareHtmlSandbox("x".repeat(MAX_SANDBOX_SOURCE_CHARS + 1), loader)).rejects.toThrow("too large");
    expect(loader).not.toHaveBeenCalled();
    await expect(prepareHtmlSandbox('<script src="pix:three"></script>', async () => "https://evil.example/engine.js"))
      .rejects.toThrow("Invalid packaged");
  });

  it("does not turn arbitrary URLs, script bodies or extra attributes into host imports", () => {
    for (const source of [
      '<script src="https://cdn.example/three.js"></script>',
      '<script src="pix:three" type="module"></script>',
      '<script>const example = \'<script src="pix:three">\';</script>',
    ]) expect(extractSandboxEngines(source)).toEqual({ html: source, engines: [] });
  });

  it("packages actual pinned engines as inert data URLs with global APIs", async () => {
    const phaser = await loadSandboxEngine("phaser");
    const three = await loadSandboxEngine("three");
    expect(phaser).toMatch(/^data:text\/javascript;base64,/);
    const phaserCode = atob(phaser.split(",")[1]!);
    expect(phaserCode).toContain("3.90.0");
    expect(phaserCode).toContain("Phaser");
    const code = atob(three.split(",")[1]!);
    const context: Record<string, any> = {};
    runInNewContext(code, context, { timeout: 5000 });
    expect(context.THREE.REVISION).toBe("186");
    expect(typeof context.THREE.WebGLRenderer).toBe("function");
    expect(context.THREE.OrbitControls).toBeUndefined();
    expect(code).toContain("Permission is hereby granted");
  });
});
