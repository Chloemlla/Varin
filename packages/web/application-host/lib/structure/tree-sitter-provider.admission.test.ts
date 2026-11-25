import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { KernelComputeGrammarParams } from "../kernel/protocol.generated.js";
import { createTreeSitterStructureProvider } from "./tree-sitter-provider.js";

it("does not identify same-length, same-mtime replacements as an unchanged grammar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "varin-grammar-admission-"));
  try {
    const file = join(dir, "fixture-identity.wasm");
    const stage = join(dir, "staged.wasm");
    const date = new Date("2020-01-01T00:00:00Z");
    writeFileSync(file, "original");
    utimesSync(file, date, date);
    const before = statSync(file, { bigint: true });
    const registrations: KernelComputeGrammarParams[] = [];
    const worker = async () => { throw new Error("fixture does not call the kernel"); };
    const provider = createTreeSitterStructureProvider({
      resolveInstalled: () => file,
      resolveInstalledLanguage: () => ({
        grammarFile: "fixture-identity.wasm",
        tagsQuery: "(function_declaration name: (identifier) @name) @definition.function",
      }),
      compute: {
        registerGrammar: async (recipe) => {
          registrations.push(recipe);
          return `fixture-${registrations.length}`;
        },
        directory: worker,
        text: worker,
      },
    });
    const request = { path: "fixture.x", text: "function test() {}", revision: "r", languageId: "fixture-grammar-identity" };
    await provider.outline(request);
    await provider.outline(request);
    writeFileSync(stage, "replaced");
    utimesSync(stage, date, date);
    renameSync(stage, file);
    const after = statSync(file, { bigint: true });
    expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);
    await provider.outline(request);
    const digest = (text: string) => `sha256-${createHash("sha256").update(text).digest("hex")}`;
    expect(registrations.map((recipe) => recipe.grammarHash))
      .toEqual([digest("original"), digest("original"), digest("replaced")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
