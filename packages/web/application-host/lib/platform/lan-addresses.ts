import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isLoopbackBindHost } from '../security/bind-host.js';

export const getLanHostAddresses = (
  bindHost: string,
  localAddress: string | undefined,
  interfaces = networkInterfaces,
): string[] => {
  if (isLoopbackBindHost(bindHost)) return [];
  if (bindHost !== '0.0.0.0' && bindHost !== '::') return [bindHost];

  // Prefer the address that actually accepted the request, including when the
  // connection is an IPv4-mapped socket on a dual-stack listener.
  const reached = localAddress?.replace(/^::ffff:/i, '');
  const primary = reached && isIPv4(reached) && !isLoopbackBindHost(reached) ? [reached] : [];
  const adjacent: string[] = [];
  const linkLocal: string[] = [];
  for (const entries of Object.values(interfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const [first, second] = entry.address.split('.');
      // 198.18.0.0/15 is used by proxy TUN interfaces for synthetic addresses.
      // It is not useful as an automatically advertised peer address.
      if (first === '198' && (second === '18' || second === '19')) continue;
      if (first === '169' && second === '254') linkLocal.push(entry.address);
      else adjacent.push(entry.address);
    }
  }
  return [...new Set([...primary, ...adjacent, ...linkLocal])];
};
