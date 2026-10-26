import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

type ResolvedAddress = { address: string; family: 4 | 6 };

export type PublicAddressLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

const nonPublicIpv4Ranges = new BlockList();
const nonPublicIpv6Ranges = new BlockList();

// Conservative egress policy from the IANA special-purpose IPv4/IPv6 registries.
// Translation and transition prefixes are denied because they can encode a private IPv4 target.
for (const [range, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['255.255.255.255', 32],
] as const) nonPublicIpv4Ranges.addSubnet(range, prefix, 'ipv4');

for (const [range, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['100:0:0:1::', 64], ['2001::', 23], ['2001:2::', 48], ['2001:3::', 32],
  ['2001:4:112::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2001:30::', 28], ['2001:db8::', 32],
  ['2002::', 16], ['2620:4f:8000::', 48], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8],
] as const) nonPublicIpv6Ranges.addSubnet(range, prefix, 'ipv6');

const systemLookup: PublicAddressLookup = (hostname, options) => lookup(hostname, options);

/** Resolve and pin a public HTTPS destination before connecting. Every DNS answer must be public. */
export async function resolvePublicHttpsUrl(url: URL, resolver: PublicAddressLookup = systemLookup): Promise<ResolvedAddress[]> {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Chỉ được truy cập URL HTTPS công khai trên cổng 443.');
  }

  const hostname = url.hostname.toLowerCase();
  const hostnameWithoutTrailingDot = hostname.replace(/\.$/, '');
  if (/(?:^|\.)(?:localhost|local|internal|home\.arpa|lan|home|corp|test|invalid|example)$/i.test(hostnameWithoutTrailingDot)) {
    throw new Error('Địa chỉ này không được phép.');
  }

  const ipAddress = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const family = isIP(ipAddress);
  const addresses = family
    ? [{ address: ipAddress, family: family as 4 | 6 }]
    : await resolver(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(({ address, family: resolvedFamily }) =>
    (resolvedFamily !== 4 && resolvedFamily !== 6) || isIP(address) !== resolvedFamily || !isPublicNetworkAddress(address))) {
    throw new Error('Host trỏ tới địa chỉ mạng riêng hoặc dành riêng.');
  }
  return addresses as ResolvedAddress[];
}

/** Return true only for ordinary globally routable unicast addresses suitable for public web fetches. */
export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublicIpv4Ranges.check(address, 'ipv4');
  if (family !== 6 || nonPublicIpv6Ranges.check(address, 'ipv6')) return false;

  // Only global-unicast space is accepted. This also rejects site-local, link-local,
  // multicast, and future/non-global allocations if the range table is incomplete.
  const firstWord = Number.parseInt(address.split(':', 1)[0] || '0', 16);
  return (firstWord & 0xe000) === 0x2000;
}
