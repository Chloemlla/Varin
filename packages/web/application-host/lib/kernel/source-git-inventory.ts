import { createHash } from 'node:crypto';
import { waitForManagedExit, type ManagedSpawn } from '../process/types.js';
import { isNotGitRepositoryError, isUnbornHeadError, parseGitNullList, parseGitStageList, type BaselineInventory } from '../harness/working-state/workspace-baseline.js';
/** Read-only Git inventory for native source capture; all processes remain Kernel-owned. */
export function createSourceGitInventory(options: { spawn: ManagedSpawn; gitBinary: string; env: NodeJS.ProcessEnv }) {
  const abortError = () => new DOMException('Source inventory cancelled', 'AbortError');
  const runGit = async (cwd: string, args: string[], input?: Buffer | string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const child = await options.spawn(options.gitBinary, args, { cwd, env: options.env, shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let failure: Error | undefined;
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => { failure ??= error; });
    child.stdin?.on('error', error => { failure ??= error; });
    if (input !== undefined) child.stdin?.end(input);
    await waitForManagedExit(child);
    signal?.throwIfAborted();
    if (failure) throw failure;
    const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (child.exitCode !== 0) throw new Error(result.stderr.trim() || 'Git inventory process did not succeed');
    return result;
  };
  const inspect = async (
    directory: string,
    signal?: AbortSignal,
  ): Promise<BaselineInventory> => {
    if (signal?.aborted) throw abortError();
    let inside: string;
    try {
      inside = (await runGit(directory, ["rev-parse", "--is-inside-work-tree"], undefined, signal)).stdout.trim();
    } catch (error) {
      if (isNotGitRepositoryError(error)) return { kind: "directory" };
      throw error;
    }
    if (inside !== "true") return { kind: "directory" };
    let baseRef = "zero-commit";
    let unborn = false;
    try {
      if (signal?.aborted) throw abortError();
      const head = (await runGit(directory, ["rev-parse", "HEAD"], undefined, signal)).stdout.trim();
      if (head && head !== "HEAD") baseRef = head;
    } catch (error) {
      if (!isUnbornHeadError(error)) throw error;
      unborn = true;
      baseRef = "zero-commit";
    }
    const collect = async (args: string[]): Promise<string> => {
      if (signal?.aborted) throw abortError();
      return (await runGit(directory, args, undefined, signal)).stdout;
    };
    const [untracked, unstaged, staged, stagedMeta, versusHead] = await Promise.all([
      collect(["ls-files", "--others", "--exclude-standard", "-z"]),
      collect(["diff", "--relative", "--name-only", "-z", "--", "."]),
      collect(["diff", "--relative", "--cached", "--name-only", "-z", "--", "."]),
      collect(["ls-files", "-s", "-z"]),
      unborn ? Promise.resolve("") : collect(["diff", "--relative", "--name-only", "-z", "HEAD", "--", "."]),
    ]);
    signal?.throwIfAborted();
    // Stage records include every tracked path, including index conflicts and
    // files absent from disk. Reuse them rather than spawning two more
    // ls-files processes. A staged deletion may no longer be in the index, so
    // the diff paths still supply it.
    const entries = parseGitStageList(stagedMeta);
    const gitlinks = [...new Set(
      entries
        .filter((entry) => entry.mode === "160000")
        .map((entry) => entry.path),
    )].sort();
    const indexModes: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.mode === "100644" || entry.mode === "100755") indexModes[entry.path] = entry.mode;
    }
    // Content is captured and verified by the native file owner. Computing a
    // second full raw hash inventory here would reread every body before each
    // capture, defeating native unchanged-file reuse (and Git clean files can
    // still be changed without updating HEAD or the index).
    return {
      kind: "git",
      baseRef,
      unborn,
      paths: [...new Set([
        ...entries.map((entry) => entry.path),
        ...parseGitNullList(untracked),
        ...parseGitNullList(unstaged),
        ...parseGitNullList(staged),
        ...parseGitNullList(versusHead),
      ])].sort(),
      gitlinks,
      indexFingerprint: createHash("sha256").update(stagedMeta).digest("hex"),
      indexModes,
    };
  };

  return inspect;
}
