import { createHash } from 'node:crypto';
import { attachmentMimeType, type Attachment } from '@varin/protocol';
import { HarnessServiceError } from '../harness/service-error.js';

export interface AttachmentUpload { key: string; filename: string; mimeType: string; byteLength: number }

export function validateAttachmentFilename(value: string): string {
  if (!value.trim() || value === '.' || value === '..' || /[\\/]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new HarnessServiceError('invalid-params', 'The attachment filename is invalid');
  return value;
}

/** A staged upload can return its final reference before Storage is awake. */
export function attachmentUploadIdentity(threadId: string, request: AttachmentUpload): Attachment {
  validateAttachmentFilename(request.filename);
  if (!request.key || !Number.isSafeInteger(request.byteLength) || request.byteLength < 0)
    throw new HarnessServiceError('invalid-params', 'The attachment upload metadata is invalid');
  const ref = 'attachment:' + createHash('sha256').update(JSON.stringify([threadId, 'upload', request.key])).digest('hex');
  return { ref, filename: request.filename, mimeType: attachmentMimeType(request.filename, request.mimeType), byteLength: request.byteLength };
}
