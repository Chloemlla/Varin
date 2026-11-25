/**
 * Downloads and extracts local sherpa-onnx STT model archives.
 * Archives (.tar.bz2) come from the k2-fsa GitHub releases and are extracted
 * with the system `tar` into the speech-models directory.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

import { fetchComponentFile, type ComponentFetch } from '../../components/file-transfer.js';
import { getLocalSttModelSpec } from './model-catalog.js';

async function hasRequiredFiles(modelDir: string, requiredFiles: string[]): Promise<boolean> {
  const results = await Promise.all(
    requiredFiles.map(async (rel) => {
      try {
        const s = await stat(path.join(modelDir, rel));
        if (s.isDirectory()) {
          return true;
        }
        return s.isFile() && s.size > 0;
      } catch {
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

async function downloadToFile(
  url: string,
  outputPath: string,
  onProgress: ((downloadedBytes: number, totalBytes: number | null) => void) | undefined,
  fetcher: ComponentFetch,
): Promise<void> {
  const tmpPath = `${outputPath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fetchComponentFile(url, tmpPath, {
      label: 'Speech model', fetcher,
      ...(onProgress ? { onProgress: (downloadedBytes, totalBytes) => onProgress(downloadedBytes, totalBytes ?? null) } : {}),
    });
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractTarArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    // GNU tar treats the colon in a Windows drive-qualified archive name as a remote host.
    const child = spawn('tar', ['xf', path.relative(destDir, archivePath)], {
      cwd: destDir,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Check whether a model is fully installed (all required files present).
 * @param {string} modelsDir
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
export async function isLocalSttModelInstalled(modelsDir: string, modelId: string): Promise<boolean> {
  const spec = getLocalSttModelSpec(modelId);
  return hasRequiredFiles(path.join(modelsDir, spec.extractedDir), spec.requiredFiles);
}

/**
 * Ensure a model is downloaded and extracted. Resolves with the model dir.
 *
 * Extraction is staged: the archive unpacks into a temporary directory and is
 * verified before being renamed into place. An interrupted or failed tar must
 * never leave partial files at the final path — the installed check only
 * verifies file presence, so a truncated .onnx there would be treated as an
 * installed model forever ("Protobuf parsing failed" at load time).
 *
 * @param {{ modelsDir: string, modelId: string,
 *           onProgress?: (downloadedBytes: number, totalBytes: number | null) => void }} options
 * @returns {Promise<string>}
 */
export async function ensureLocalSttModel({ modelsDir, modelId, onProgress, fetcher = fetch }: {
  modelId: string;
  modelsDir: string;
  fetcher?: ComponentFetch;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
}): Promise<string> {
  const spec = getLocalSttModelSpec(modelId);
  const modelDir = path.join(modelsDir, spec.extractedDir);
  if (await hasRequiredFiles(modelDir, spec.requiredFiles)) {
    return modelDir;
  }

  // A directory that exists but fails the required-files check is a partial
  // extraction from an earlier interrupted attempt — remove it before retrying.
  await rm(modelDir, { recursive: true, force: true }).catch(() => undefined);

  const downloadsDir = path.join(modelsDir, '.downloads');
  const archiveFilename = path.basename(new URL(spec.archiveUrl).pathname);
  const archivePath = path.join(downloadsDir, archiveFilename);

  if (!(await isNonEmptyFile(archivePath))) {
    await downloadToFile(spec.archiveUrl, archivePath, onProgress, fetcher);
  }

  const stagingDir = path.join(modelsDir, `.staging-${spec.extractedDir}-${randomUUID()}`);
  try {
    await extractTarArchive(archivePath, stagingDir);

    const stagedModelDir = path.join(stagingDir, spec.extractedDir);
    if (!(await hasRequiredFiles(stagedModelDir, spec.requiredFiles))) {
      // Bad archive (truncated download / corrupt cache): drop it so the next
      // attempt re-downloads instead of re-extracting the same broken bytes.
      await rm(archivePath, { force: true }).catch(() => undefined);
      throw new Error(
        `Extracted ${archiveFilename}, but required model files are missing or empty. The archive was discarded; retry to re-download.`,
      );
    }

    await rename(stagedModelDir, modelDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    // Any extraction failure means the cached archive can't be trusted
    // (corrupt bz2, truncated download). Discard it so retry re-downloads.
    await rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);

  await rm(archivePath, { force: true }).catch(() => undefined);

  return modelDir;
}
