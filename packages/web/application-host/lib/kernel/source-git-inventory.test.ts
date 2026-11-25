import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseGitNullList } from "../harness/working-state/workspace-baseline.js";
import { createSourceGitInventory } from "./source-git-inventory.js";

it("reuses the same index snapshot for tracked paths, deletion and mode data", async () => {
  const root = mkdtempSync(join(tmpdir(), "varin-inventory-git-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const seen: string[][] = [];
  const inventory = createSourceGitInventory({ gitBinary: "git", env: process.env, spawn: (command, args, options) => {
    seen.push([...args]);
    const child = spawn(command, args, options);
    return Object.assign(child, { completion: new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    }) });
  } });
  const previous = (cwd: string, unborn = false) => {
    const probes = [
      ["ls-files", "-z"], ["ls-files", "-d", "-z"], ["ls-files", "--others", "--exclude-standard", "-z"],
      ["diff", "--relative", "--name-only", "-z", "--", "."],
      ["diff", "--relative", "--cached", "--name-only", "-z", "--", "."],
      ...(unborn ? [] : [["diff", "--relative", "--name-only", "-z", "HEAD", "--", "."]]),
    ];
    return [...new Set(probes.flatMap((probe) => parseGitNullList(git(cwd, ...probe))))].sort();
  };
  try {
    expect(await inventory(root)).toEqual({ kind: "directory" });
    git(root, "init", "-q");
    mkdirSync(join(root, "inside"));
    writeFileSync(join(root, "inside", "staged-phase"), "first");
    git(root, "add", ".");
    const unborn = await inventory(root);
    expect(unborn).toMatchObject({ kind: "git", unborn: true, paths: previous(root, true) });

    writeFileSync(join(root, "inside", "staged removal"), "one");
    writeFileSync(join(root, "inside", "working removal"), "two");
    writeFileSync(join(root, "outside"), "three");
    git(root, "add", ".");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    git(root, "rm", "-q", "inside/staged removal");
    rmSync(join(root, "inside", "working removal"));
    writeFileSync(join(root, "inside", "untracked"), "four");
    writeFileSync(join(root, "inside", "staged-phase"), "changed");
    for (const cwd of [root, join(root, "inside")]) {
      seen.length = 0;
      const actual = await inventory(cwd);
      expect(actual).toMatchObject({ kind: "git", unborn: false, paths: previous(cwd) });
      expect(seen).toHaveLength(7);
      expect(seen.filter((argv) => argv[0] === "ls-files")).toEqual([
        ["ls-files", "--others", "--exclude-standard", "-z"], ["ls-files", "-s", "-z"],
      ]);
      expect(actual.kind === "git" && Object.values(actual.indexModes ?? {})).toContain("100644");
    }
    const cancel = new AbortController();
    cancel.abort();
    seen.length = 0;
    await expect(inventory(root, cancel.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
