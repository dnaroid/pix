import { describe, expect, it } from "vitest";

describe("desktop startup theme", () => {
  it("paints the document for the system color scheme before the app bundle loads", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const htmlPath = path.resolve(__dirname, "../index.html");
    // @ts-expect-error Node __dirname in Vitest runner
    const stylesPath = path.resolve(__dirname, "styles.css");
    const html = fs.readFileSync(htmlPath, "utf-8");
    const styles = fs.readFileSync(stylesPath, "utf-8");

    const startupStyleEnd = html.indexOf("</style>");
    const appBundleStart = html.indexOf('<script type="module"');

    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(startupStyleEnd).toBeGreaterThan(0);
    expect(startupStyleEnd).toBeLessThan(appBundleStart);
    expect(html).toContain("--startup-background: #faf9f5;");
    expect(html).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--startup-background: #0f1115;/,
    );
    expect(html).toContain("background: var(--startup-background);");

    expect(styles).toMatch(/:root\s*\{[\s\S]*?--background: #faf9f5;/);
    expect(styles).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*?:root\s*\{[\s\S]*?--background: #0f1115;/,
    );
  });
});
