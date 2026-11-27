import type { SourceResourceOwner } from '@varin/protocol';
import type { ManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import type { OfficeRenderer } from './renderer.js';

/** Conversion has no workspace writes. Its only input is the exact document already read
 * by the Host's material owner, and export commits through its existing file owner. */
export function createManagedOfficeRenderer(
  targets: Pick<ManagedRemoteTargetRegistry, 'withSourceUse' | 'forwardTarget' | 'clientFor'>,
  owner: Extract<SourceResourceOwner, { kind: 'managed_host' }>,
): OfficeRenderer {
  return {
    environment: () => targets.withSourceUse(owner, async () => {
      const target = await targets.forwardTarget(owner);
      return targets.clientFor(target).request('/office/environment', { method: 'GET' });
    }),
    convert: (bytes, sourceFormat, format, signal) => targets.withSourceUse(owner, async () => {
      const target = await targets.forwardTarget(owner, signal);
      const client = targets.clientFor(target);
      // A lost conversion response leaves only target-owned scratch. The Host
      // has no file operation to reconcile until it receives the output bytes.
      const response = await client.response('/office/convert', { method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength),
          'x-varin-office-source': sourceFormat, 'x-varin-office-format': format },
        body: new Uint8Array(bytes), ...(signal ? { signal } : {}) });
      const output = Buffer.from(await response.arrayBuffer());
      if (response.headers.get('x-varin-office-format') !== format || !output.byteLength)
        throw new Error('The target returned an invalid Office result');
      const encodedVersion = response.headers.get('x-varin-office-version');
      return { bytes: output, format, engine: { name: 'LibreOffice',
        version: encodedVersion ? Buffer.from(encodedVersion, 'base64url').toString('utf8') : '' },
        recalculated: sourceFormat === 'xlsx' && format === 'xlsx' };
    }, signal),
  };
}
