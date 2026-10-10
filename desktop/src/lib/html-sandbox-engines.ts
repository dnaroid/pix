export type SandboxEngine = "phaser" | "three";
export type SandboxEngineLoader = (engine: SandboxEngine) => Promise<string>;

/** Fixed lazy imports: guest source never selects a host path or arbitrary URL. */
export const loadSandboxEngine: SandboxEngineLoader = async (engine) => {
  switch (engine) {
    case "phaser": return (await import("virtual:pix-sandbox-phaser")).default;
    case "three": return (await import("virtual:pix-sandbox-three")).default;
  }
};

/** Only canonical, empty classic script declarations opt into packaged code. */
export function extractSandboxEngines(source: string): { html: string; engines: SandboxEngine[] } {
  const engines = new Set<SandboxEngine>();
  const html = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attributes: string, body: string) => {
    const marker = attributes.match(/^\s+src\s*=\s*(["'])pix:([^"']+)\1\s*$/i);
    if (!marker) return whole;
    const engine = marker[2];
    if (engine !== "phaser" && engine !== "three") throw new Error(`Unknown sandbox engine: ${engine}. Use pix:phaser or pix:three.`);
    if (body.trim()) throw new Error("Sandbox engine script declarations must be empty.");
    engines.add(engine);
    return "";
  });
  return { html, engines: [...engines] };
}
