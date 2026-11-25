import { Worker } from "node:worker_threads";
import type { PdfPageImage, PdfRenderInput } from "./pdf-engine.js";

interface PdfAssets { cMapUrl: string; standardFontDataUrl: string; wasmUrl: string; iccUrl: string }
type Result = Omit<PdfPageImage, "data"> & { bytes: ArrayBuffer };
type Reply = { result: Result } | { error: { name: string; message: string } };

// Keep this embedded entry consistent across source runs, Host builds, and
// Electron. All heavyweight work, including PNG compression, stays here.
const PROGRAM = String.raw`
import { parentPort, workerData } from "node:worker_threads";
const { moduleUrl, assets, source, page: pageNumber, scale, region } = workerData;
try {
  const pdfjs = await import(moduleUrl);
  const loading = pdfjs.getDocument({ data: new Uint8Array(source), ...assets, cMapPacked: true });
  let result;
  try {
    const doc = await loading.promise;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
      throw new RangeError("PDF page " + pageNumber + " is outside 1.." + doc.numPages);
    }
    const page = await doc.getPage(pageNumber);
    const full = page.getViewport({ scale });
    const left = Math.floor(region.x * full.width);
    const top = Math.floor(region.y * full.height);
    const right = Math.ceil((region.x + region.width) * full.width);
    const bottom = Math.ceil((region.y + region.height) * full.height);
    const width = right - left;
    const height = bottom - top;
    if (![left, top, right, bottom, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0) {
      throw new RangeError("PDF render dimensions are not representable");
    }
    const canvas = doc.canvasFactory.create(width, height);
    try {
      const viewport = page.getViewport({ scale, offsetX: -left, offsetY: -top });
      await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport, background: "#ffffff" }).promise;
      const bytes = Uint8Array.from(canvas.canvas.toBuffer("image/png")).buffer;
      const original = page.getViewport({ scale: 1 });
      result = { bytes, mimeType: "image/png", width, height, pageWidth: original.width, pageHeight: original.height,
        region: { x: left / full.width, y: top / full.height, width: width / full.width, height: height / full.height },
        parser: "pdfjs", parserVersion: pdfjs.version };
    } finally { doc.canvasFactory.destroy(canvas); }
  } finally { await loading.destroy().catch(() => undefined); }
  parentPort.postMessage({ result }, [result.bytes]);
} catch (error) {
  parentPort.postMessage({ error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } });
}
`;
const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(PROGRAM)}`);
const abortReason = (signal?: AbortSignal) => signal?.reason ?? new DOMException("PDF operation aborted", "AbortError");

let running = false;
const pending: Array<() => void> = [];
const dequeue = () => {
  const next = pending.shift();
  if (next) next();
  else running = false;
};

const runWorker = (input: PdfRenderInput, moduleUrl: string, assets: PdfAssets): Promise<PdfPageImage> => {
  input.signal?.throwIfAborted();
  const scale = input.scale ?? 2;
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("PDF render scale must be positive");
  const region = input.region ?? { x: 0, y: 0, width: 1, height: 1 };
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)
      || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
      || region.x + region.width > 1 + Number.EPSILON || region.y + region.height > 1 + Number.EPSILON) {
    throw new RangeError("PDF region must be a non-empty rectangle within the normalized page");
  }
  // Transfer a private copy, never detach caller-owned bytes (including pooled Buffer slices).
  const source = Uint8Array.from(input.source).buffer;
  const worker = new Worker(workerUrl, {
    workerData: { moduleUrl, assets, source, page: input.page, scale, region }, transferList: [source], execArgv: [],
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error: unknown, result?: Result) => {
      if (done) return;
      done = true;
      input.signal?.removeEventListener("abort", abort);
      // Retain the shared raster slot until the worker is actually stopped.
      void worker.terminate().then(() => {
        if (input.signal?.aborted) reject(abortReason(input.signal));
        else if (!result) reject(error);
        else {
          const { bytes, ...image } = result;
          resolve({ ...image, data: Buffer.from(bytes) });
        }
      }, reject);
    };
    const abort = () => finish(abortReason(input.signal));
    worker.once("message", (message: Reply) => {
      if ("result" in message) finish(undefined, message.result);
      else {
        const error = message.error.name === "RangeError" ? new RangeError(message.error.message) : new Error(message.error.message);
        error.name = message.error.name;
        finish(error);
      }
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => finish(new Error(`PDF raster worker exited before returning a result (${code})`)));
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
  });
};

/** Start one raster worker on demand; queued inputs do not allocate canvases or copy sources. */
export const rasterizePdf = (input: PdfRenderInput, moduleUrl: string, assets: PdfAssets): Promise<PdfPageImage> =>
  new Promise((resolve, reject) => {
    if (input.signal?.aborted) { reject(abortReason(input.signal)); return; }
    const cancel = () => {
      const i = pending.indexOf(start);
      if (i !== -1) pending.splice(i, 1);
      reject(abortReason(input.signal));
    };
    const start = () => {
      input.signal?.removeEventListener("abort", cancel);
      void Promise.resolve().then(() => runWorker(input, moduleUrl, assets)).then(resolve, reject).finally(dequeue);
    };
    if (running) {
      pending.push(start);
      input.signal?.addEventListener("abort", cancel, { once: true });
    } else {
      running = true;
      start();
    }
  });
