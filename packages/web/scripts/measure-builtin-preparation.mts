// Measured entry points: the real Host's extension directory, context and service leases.
// This is not model latency. For model-boundary coverage use context-composition-review.native.test.ts.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channel } from 'node:diagnostics_channel';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createExtensionTools } from '../application-host/lib/kernel/extension-tool-owner.ts';
import { createContextComposition } from '../application-host/lib/kernel/context-composition.ts';
import type { KernelClient } from '../application-host/lib/kernel/kernel-client.ts';

const legacy = process.argv.includes('--legacy');
const botsArg = process.argv.find(arg => arg.startsWith('--bots='));
const bots = botsArg === undefined ? 1 : Number(botsArg.slice(7));
if (!Number.isSafeInteger(bots) || bots < 1) throw new Error('Expected a positive integer for --bots');
const dataDir = await mkdtemp(join(tmpdir(), 'varin-directory-bench-'));
const brokerScript = fileURLToPath(new URL('../../extension-host/broker/broker-child.mjs', import.meta.url));
const runtime = await ApplicationExtensionRuntime.create({dataDir, varinVersion: '0.9.53', brokerScript});
const starts: ChildProcess[] = [];
const observed = channel('tracing:child_process.spawn:start');
const count = (value: unknown) => {
  const message = value as { options: { args: string[] }; process: ChildProcess };
  if (message.options.args.includes(brokerScript)) starts.push(message.process);
};
async function privateKiB(pid: number) {
  if (process.platform !== 'linux') return null;
  try {
    const fields = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    return [...fields.matchAll(/^Private_(?:Clean|Dirty):\s+(\d+) kB$/gm)].reduce((n, match) => n + Number(match[1]), 0);
  } catch { return null; }
}
async function sampleMemory(pids: number[]) {
  if (process.platform !== 'win32') return Promise.all(pids.map(privateKiB));
  // Query the Host and all its live brokers in one OS sample. Private bytes on
  // Windows count committed memory; Linux smaps counts private resident pages.
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64 | ConvertTo-Json -Compress`],
  { windowsHide: true });
  const rows = [JSON.parse(stdout)].flat() as Array<{ Id: number; PrivateMemorySize64: number }>;
  return pids.map(pid => {
    const row = rows.find(process => process.Id === pid);
    return row ? row.PrivateMemorySize64 / 1024 : null;
  });
}
observed.subscribe(count);
try {
  // A/B only. Keep real legacy package bytes, actual child processes, and the same routing.
  if (legacy) runtime.packages.isDistributionArtifact = async () => false;
  await runtime.start();
  const context = createContextComposition(runtime);
  const prepare = createExtensionTools({runtime, kernel: {} as KernelClient, currentPolicy: async () => ({ mode: 'normal', rules: [] })});
  for (const pass of ['cold', 'warm']) {
    const begin = performance.now(), before = starts.length;
    const scopes: Awaited<ReturnType<typeof prepare>>[] = [];
    try {
      await Promise.all(Array.from({length: bots}, async (_, index) => {
        const threadId = `bot-${index}`;
        const prepared = await prepare({ threadId, branchId: 'branch', runId: `${threadId}-${pass}`, source: null }, [], new AbortController().signal);
        scopes.push(prepared);
        await context({ threadId });
      }));
      const ms = Math.round(performance.now() - begin);
      // Exclude final GC/settling from preparation latency. The tool leases are still
      // held during the sample. Context declarations no longer hold an execution lease.
      await new Promise(resolve => setTimeout(resolve, 250));
      global.gc?.();
      const live = starts.filter(child => child.pid && child.exitCode === null && child.signalCode === null);
      const [hostPrivateKiB, ...memory] = await sampleMemory([process.pid, ...live.map(child => child.pid!)]);
      console.log(JSON.stringify({ mode: legacy ? 'legacy' : 'host', pass, bots, toolCounts: scopes.map(s => s.initial.length),
        prepareMs: ms, brokerStarts: starts.length - before, liveBrokers: live.length, hostPrivateKiB,
        brokerPrivateKiB: memory.every(kib => kib !== null) ? memory.reduce<number>((n, kib) => n + kib!, 0) : null }));
    } finally {
      for (const scope of scopes) { scope.close(); for (const entry of scope.initial) entry.lease.release(); }
    }
  }
} finally {
  observed.unsubscribe(count);
  await runtime.stop(); await rm(dataDir, { recursive: true, force: true });
}
