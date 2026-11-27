import type { IncomingMessage } from 'node:http';
import { requestBodyChunks } from './managed-remote-service.js';
import type { ManagedSourceServiceRequest, SourceServiceOperation } from './managed-remote-types.js';

type BinaryWrite = Extract<SourceServiceOperation, { kind: 'binary_write' }>;

export function encodeManagedBinaryWrite(input: ManagedSourceServiceRequest, operation: BinaryWrite) {
  const { bytes, bytesBase64, ...metadata } = operation;
  const content = bytes ?? Buffer.from(bytesBase64!, 'base64');
  const envelope = Buffer.from(JSON.stringify({ ...input, operation: metadata }));
  return {
    headers: { 'content-type': 'application/octet-stream', 'x-varin-envelope-length': String(envelope.length),
      'content-length': String(envelope.length + content.byteLength) },
    body: (async function* () { yield envelope; yield content; })(),
  };
}

export async function readManagedBinaryWrite(request: IncomingMessage, signal: AbortSignal): Promise<ManagedSourceServiceRequest> {
  const envelopeLength = Number(request.headers['x-varin-envelope-length']);
  const contentLength = Number(request.headers['content-length']);
  // Match the existing Resource Node JSON request budget for metadata.
  if (!Number.isSafeInteger(envelopeLength) || envelopeLength <= 0 || envelopeLength > 4 * 1024 * 1024
    || !Number.isSafeInteger(contentLength) || contentLength < envelopeLength) throw new Error('Invalid binary write framing');
  const envelope = Buffer.alloc(envelopeLength);
  const content: Uint8Array[] = [];
  let read = 0;
  for await (const chunk of requestBodyChunks(request)) {
    signal.throwIfAborted();
    if (read + chunk.byteLength > contentLength) throw new Error('Invalid binary write byte length');
    const envelopeBytes = Math.min(Math.max(0, envelopeLength - read), chunk.byteLength);
    if (envelopeBytes > 0) envelope.set(chunk.subarray(0, envelopeBytes), read);
    if (envelopeBytes < chunk.byteLength) content.push(chunk.subarray(envelopeBytes));
    read += chunk.byteLength;
  }
  signal.throwIfAborted();
  if (read !== contentLength) throw new Error('The transferred file content is incomplete');
  const input = JSON.parse(envelope.toString('utf8')) as ManagedSourceServiceRequest;
  if (input.operation?.kind !== 'binary_write' || input.operation.byteLength !== contentLength - envelopeLength)
    throw new Error('Invalid binary write metadata');
  const { bytesBase64: _base64, bytes: _bytes, ...metadata } = input.operation;
  const bytes = Buffer.concat(content, input.operation.byteLength);
  return { ...input, operation: { ...metadata, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) } };
}
