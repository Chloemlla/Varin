import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import express from "express";
import type { Request, Response } from "express";
import { registerLocalSemanticComponentRoutes } from "./local-component-routes.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import {
  createLocalSemanticComponentManager,
  LOCAL_SEMANTIC_TRANSFORMERS_ENTRY,
  LOCAL_SEMANTIC_WORKER_ENTRY,
} from "./local-component.js";
import { resolveInstalledModelPack } from "./model-store.js";
import { LOCAL_SEMANTIC_TOKENIZER_ENTRY } from './local-component-manifest.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function makeArchive(options: { extra?: string; schemaVersion?: number; modelBytes?: string } = {}): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "varin-local-semantic-source-"));
  roots.push(source);
  const files: Record<string, Uint8Array> = {
    "model/recipe.json": new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      provider: "local",
      model: "all-MiniLM-L6-v2",
      modelRevision: "test",
      dim: 3,
      pooling: "mean",
      normalize: true,
      maxTokens: 512,
      onnxFile: "onnx/model_quantized.onnx",
      tokenizerFile: "tokenizer.json",
    })),
    "model/tokenizer.json": new TextEncoder().encode("{}"),
    "model/tokenizer_config.json": new TextEncoder().encode("{}"),
    [LOCAL_SEMANTIC_TOKENIZER_ENTRY]: new TextEncoder().encode("export default {};"),
    "model/onnx/model_quantized.onnx": new TextEncoder().encode(options.modelBytes ?? "test-onnx"),
    [LOCAL_SEMANTIC_TRANSFORMERS_ENTRY]: new TextEncoder().encode("export default {};"),
    [LOCAL_SEMANTIC_WORKER_ENTRY]: new TextEncoder().encode("export default {};"),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = join(source, ...name.split("/"));
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, bytes);
  }
  if (options.extra) {
    const extraFile = join(source, ...options.extra.split("/"));
    await mkdir(join(extraFile, ".."), { recursive: true });
    await writeFile(extraFile, "unexpected");
  }
  const manifest = {
    schemaVersion: options.schemaVersion ?? 4,
    workerProtocol: 1,
    id: "local-semantic",
    version: "test-version",
    platform: process.platform,
    arch: process.arch,
    modelPath: "model",
    transformersEntry: LOCAL_SEMANTIC_TRANSFORMERS_ENTRY,
    workerEntry: LOCAL_SEMANTIC_WORKER_ENTRY,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.byteLength }])),
  };
  await writeFile(join(source, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const archive = join(source, "component.tar.gz");
  await createTar({ file: archive, cwd: source, gzip: true, portable: true }, ["manifest.json", ...Object.keys(files), ...(options.extra ? [options.extra] : [])]);
  return archive;
}

describe("local semantic component manager", () => {
  it("keeps the component unavailable without importing a runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test" });
    expect(manager.status()).toEqual({ status: "not-installed" });
    const embedderModule = await import("./local-embedder.js");
    expect(embedderModule.createLocalSemanticEmbedder({ dataDir }).status).toBe("unavailable");
    await manager.dispose();
  });

  it("reports a damaged active pointer as failed rather than not-installed", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const pointer = join(dataDir, "optional-components/local-semantic/active.json");
    await mkdir(join(pointer, ".."), { recursive: true });
    await writeFile(pointer, "{not-json", "utf8");
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test" });
    expect(manager.status()).toEqual({ status: "failed", error: expect.any(String) });
    await manager.dispose();
  });

  it("rejects files outside the manifest without publishing an active pointer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const archive = await makeArchive({ extra: "unexpected.txt" });
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test", validatePack: async () => undefined });
    await manager.importArchive(archive);
    expect(manager.status().status).toBe("failed");
    expect(resolveInstalledModelPack(dataDir)).toBeNull();
    await expect(readFile(join(dataDir, "optional-components/local-semantic/active.json"))).rejects.toThrow();
    await manager.dispose();
  });

  it("verifies and enables a complete package atomically", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const archive = await makeArchive();
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test", validatePack: async () => undefined });
    await manager.importArchive(archive);
    expect(manager.status()).toMatchObject({ status: "ready", version: "test-version" });
    expect(resolveInstalledModelPack(dataDir)).toMatchObject({ source: "component", recipe: { dim: 3 } });
    await manager.dispose();
  });

  it("routes an authenticated offline import to the executing Host and exposes status to another client", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-executing-"));
    const otherDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-separate-"));
    roots.push(dataDir, otherDir);
    const archive = await readFile(await makeArchive());
    const options = {
      version: "test",
      fetch: async () => { throw new Error("network disabled"); },
      validatePack: async () => undefined,
    };
    const owner = createLocalSemanticComponentManager({ ...options, dataDir });
    const other = createLocalSemanticComponentManager({ ...options, dataDir: otherDir });
    const router = express.Router();
    registerLocalSemanticComponentRoutes(router as unknown as express.Express, {
      manager: owner, requireAuth: (req, res, next) => {
        if (req.headers.authorization !== "Bearer test-owner") res.status(401).json({ error: "unauthorized" });
        else next();
      },
    });
    const boundary = "varin-offline-test";
    const bytes = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="component.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`),
      archive, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const call = (method: string, url: string, client: string, body?: Buffer, authed = true) => {
      const req = Object.assign(new PassThrough(), {
        method, url, headers: {
          ...(authed ? { authorization: "Bearer test-owner" } : {}),
          "user-agent": client,
          ...(body ? { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) } : {}),
        },
      });
      return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const res = {
          statusCode: 200,
          status(code: number) { this.statusCode = code; return this; },
          setHeader() {},
          json(body: unknown) { resolve({ status: this.statusCode, body }); return this; },
        };
        router(req as unknown as Request, res as unknown as Response, reject);
        req.end(body);
      }).finally(() => req.destroy());
    };
    try {
      const prefix = "/api/harness/local-semantic";
      expect(await call("POST", prefix + "/import", "mobile-test", bytes, false)).toMatchObject({ status: 401 });
      expect(await call("POST", prefix + "/import", "mobile-test", bytes)).toMatchObject({ status: 202 });
      await expect.poll(() => owner.status().status).toBe("ready");
      expect(await call("GET", prefix, "light-desktop-test")).toMatchObject({
        status: 200, body: { status: "ready", version: "test-version" },
      });
      expect(resolveInstalledModelPack(dataDir)?.source).toBe("component");
      expect(other.status()).toEqual({ status: "not-installed" });
      expect(resolveInstalledModelPack(otherDir)).toBeNull();
    } finally {
      await Promise.all([owner.dispose(), other.dispose()]);
    }
  });

  it("cancels a remote replacement without losing the active model and retries through the same owner", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-download-"));
    roots.push(dataDir);
    const original = await makeArchive();
    const replacement = new Uint8Array(await readFile(await makeArchive({ modelBytes: "replacement-model" })));
    let reachedFetch!: () => void;
    const fetching = new Promise<void>((resolve) => { reachedFetch = resolve; });
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      if (++requests === 1) {
        reachedFetch();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(replacement.subarray(0, 32)); },
        }));
      }
      return new Response(replacement, { headers: { "content-length": String(replacement.byteLength) } });
    };
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test", fetch: fetcher, validatePack: async () => undefined });
    try {
      await manager.importArchive(original);
      const previous = resolveInstalledModelPack(dataDir);
      expect(previous?.root).toBeDefined();
      const installing = manager.install();
      await fetching;
      expect(manager.install()).toBe(installing);
      expect(() => manager.importArchive(original)).toThrow('Another local semantic component');
      manager.cancel();
      await installing;
      expect(manager.status()).toMatchObject({ status: "ready", error: expect.stringContaining("cancelled") });
      expect(resolveInstalledModelPack(dataDir)?.root).toBe(previous?.root);
      await manager.install();
      expect(manager.status()).toMatchObject({ status: "ready" });
      expect(resolveInstalledModelPack(dataDir)?.root).not.toBe(previous?.root);
      expect(requests).toBe(2);
    } finally {
      await manager.dispose();
    }
  });

  it("leaves the previously enabled package usable after a failed replacement", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const valid = await makeArchive();
    const invalid = await makeArchive({ extra: "unexpected.txt" });
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test", validatePack: async () => undefined });
    await manager.importArchive(valid);
    const before = resolveInstalledModelPack(dataDir);
    expect(before?.source).toBe("component");
    await manager.importArchive(invalid);
    expect(manager.status()).toMatchObject({ status: "ready", error: expect.any(String) });
    expect(resolveInstalledModelPack(dataDir)?.root).toBe(before?.root);
    await manager.dispose();
  });
});

it('rejects obsolete component archives and active manifests while preserving their bytes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-local-semantic-old-')); roots.push(dataDir);
  const archive = await makeArchive({ schemaVersion: 2 });
  const manager = createLocalSemanticComponentManager({ dataDir, version: 'test', validatePack: async () => undefined });
  await manager.importArchive(archive);
  expect(manager.status()).toMatchObject({ status: 'failed', error: expect.stringContaining('manifest format 4 and worker protocol 1') });
  expect((await readFile(archive)).length).toBeGreaterThan(0);
  const parent = join(dataDir, 'optional-components/local-semantic');
  await mkdir(join(parent, 'versions/old'), { recursive: true });
  const manifestPath = join(parent, 'versions/old/manifest.json');
  await writeFile(manifestPath, await readFile(join(archive, '../manifest.json')));
  await writeFile(join(parent, 'active.json'), JSON.stringify({ schemaVersion: 1, root: 'versions/old', version: 'old' }));
  expect(resolveInstalledModelPack(dataDir)).toBeNull();
  const reopened = createLocalSemanticComponentManager({ dataDir, version: 'test' });
  expect(reopened.status()).toMatchObject({ status: 'failed', error: expect.stringContaining('manifest format 4 and worker protocol 1') });
  await reopened.dispose();
  expect((await readFile(manifestPath, 'utf8'))).toContain('"schemaVersion":2');
  await manager.dispose();
});

it('separates identical model names and revisions when verified graph bytes change', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-local-semantic-identity-')); roots.push(dataDir);
  const manager = createLocalSemanticComponentManager({ dataDir, version: 'test', validatePack: async () => undefined });
  await manager.importArchive(await makeArchive({ modelBytes: 'first graph' }));
  const before = resolveInstalledModelPack(dataDir)!;
  await manager.importArchive(await makeArchive({ modelBytes: 'second graph' }));
  const after = resolveInstalledModelPack(dataDir)!;
  expect(after.recipe.modelRevision).toBe(before.recipe.modelRevision);
  expect(after.recipe.onnxFile).toBe(before.recipe.onnxFile);
  expect(after.space.configurationId).not.toBe(before.space.configurationId);
  expect(after.component!.manifestDigest).not.toBe(before.component!.manifestDigest);
  await expect(readFile(before.onnxPath!)).rejects.toThrow();
  expect((await readFile(after.onnxPath!, 'utf8'))).toBe('second graph');
  await manager.dispose();
});
