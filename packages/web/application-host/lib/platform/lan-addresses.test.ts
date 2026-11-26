import type { NetworkInterfaceInfoIPv4 } from 'node:os';
import { expect, it } from 'vitest';
import { getLanHostAddresses } from './lan-addresses.js';

const iface = (address: string, internal = false): NetworkInterfaceInfoIPv4 => ({
  address, internal, family: 'IPv4', netmask: '255.255.255.0', cidr: `${address}/24`, mac: '00:00:00:00:00:00',
});

it('advertises Wi-Fi ahead of proxy TUN and self-assigned addresses when settings is open on localhost', () => {
  const interfaces = () => ({
    disconnected: [iface('169.254.160.171')],
    tunnel: [iface('198.18.0.1'), iface('198.19.1.2')],
    wifi: [iface('192.168.5.2')],
    loopback: [iface('127.0.0.1', true)],
  });
  expect(getLanHostAddresses('0.0.0.0', '127.0.0.1', interfaces)).toEqual(['192.168.5.2', '169.254.160.171']);
});

it('prefers the LAN endpoint already in use and respects explicit listener bindings', () => {
  const interfaces = () => ({ ethernet: [iface('10.0.0.5')], wifi: [iface('192.168.5.2')] });
  expect(getLanHostAddresses('::', '::ffff:192.168.5.2', interfaces)).toEqual(['192.168.5.2', '10.0.0.5']);
  expect(getLanHostAddresses('10.0.0.5', '10.0.0.5', interfaces)).toEqual(['10.0.0.5']);
  expect(getLanHostAddresses('127.0.0.2', '127.0.0.2', interfaces)).toEqual([]);
});
