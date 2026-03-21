import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-holo-domain-"));
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "commonjs", strict: true,
            noEmit: true, esModuleInterop: true, rootDir: ".", skipLibCheck: true,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));
    return dir;
}

const toPosix = (p: string) => path.normalize(p).replace(/\\/g, "/");

describe("hologram domain separation", () => {
    let dir: string;

    afterEach(() => {
        if (dir) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    it("38. predictBlastRadius throws in hologram mode", () => {
        dir = createTempProject({
            "api.ts": `export function init(): void {}`,
        });

        const kernel = new NrekiKernel();
        kernel.setShadows(new Map(), new Set(), []);
        kernel.boot(dir, "hologram");

        expect(() => kernel.predictBlastRadius("api.ts", "init")).toThrow(
            "Cannot use predictBlastRadius in hologram mode",
        );
    });

    it("39. predictBlastRadius works in project mode (not hologram)", () => {
        dir = createTempProject({
            "api.ts": `export function init(): void {}`,
            "consumer.ts": `import { init } from "./api";\ninit();`,
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");

        // Should not throw in project mode
        const result = kernel.predictBlastRadius(
            path.join(dir, "api.ts"),
            "init",
        );
        expect(result).toBeDefined();
        expect(typeof result.report).toBe("string");
    });

    it("40. interceptAtomicBatch works with shadows", async () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; age: number; }`,
            "handler.ts": [
                `import { User } from "./types";`,
                `export function greet(u: User): string { return u.name; }`,
            ].join("\n"),
        });

        const typesPath = toPosix(path.resolve(dir, "types.ts"));
        const shadow = `export interface User { name: string; age: number; }`;

        const kernel = new NrekiKernel();
        kernel.setShadows(
            new Map([[typesPath, shadow]]),
            new Set([toPosix(path.resolve(dir, "handler.ts"))]),
            [],
        );
        kernel.boot(dir, "hologram");

        // Valid edit: handler still uses User correctly
        const result = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "handler.ts"),
            proposedContent: [
                `import { User } from "./types";`,
                `export function greet(u: User): string {`,
                `  return "Hello " + u.name + " (age " + u.age + ")";`,
                `}`,
            ].join("\n"),
        }]);
        expect(result.safe).toBe(true);
        await kernel.rollbackAll();

        // Breaking edit: wrong property access
        const result2 = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "handler.ts"),
            proposedContent: [
                `import { User } from "./types";`,
                `export function greet(u: User): string {`,
                `  return u.nonExistent;`,
                `}`,
            ].join("\n"),
        }]);
        expect(result2.safe).toBe(false);
    });
});
