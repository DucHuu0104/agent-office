import { describe, expect, it } from 'vitest';
import { isPublicNetworkAddress, resolvePublicHttpsUrl, type PublicAddressLookup } from './network-policy';

describe('public research network policy', () => {
  it('allows ordinary public IPv4 and IPv6 unicast destinations', () => {
    expect(isPublicNetworkAddress('1.1.1.1')).toBe(true);
    expect(isPublicNetworkAddress('93.184.216.34')).toBe(true);
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
  });

  it.each([
    '0.0.0.1', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '64:ff9b:1::a00:1', '100::1',
    '2001::1', '2001:2::1', '2001:db8::1', '2002:7f00:1::', '2620:4f:8000::1',
    '3fff::1', '5f00::1', 'fc00::1', 'fe80::1', 'ff02::1',
  ])('blocks non-public or special-purpose address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it('rejects unsafe schemes, ports, userinfo, local names, and special IPv6 literals before lookup', async () => {
    let lookupCalls = 0;
    const resolver: PublicAddressLookup = async () => { lookupCalls++; return [{ address: '93.184.216.34', family: 4 }]; };
    for (const input of [
      'http://public.example.com/', 'https://public.example.com:8443/', 'https://user:pass@public.example.com/',
      'https://localhost./', 'https://service.local/', 'https://api.internal/', 'https://router.home.arpa/',
      'https://example/', 'https://[::1]/', 'https://[2002:7f00:1::]/',
      // WHATWG URL normalizes decimal, hexadecimal and octal IPv4 spellings to canonical loopback.
      'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
      // IPv4-mapped, NAT64 and IANA dummy prefixes must not provide a path to non-public networks.
      'https://[::ffff:7f00:1]/', 'https://[64:ff9b::a00:1]/', 'https://[100:0:0:1::1]/',
    ]) {
      await expect(resolvePublicHttpsUrl(new URL(input), resolver)).rejects.toThrow();
    }
    expect(lookupCalls).toBe(0);
  });

  it('rejects a hostname if any DNS answer is private and returns only pinned validated answers', async () => {
    const mixedResolver: PublicAddressLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ];
    await expect(resolvePublicHttpsUrl(new URL('https://mixed.example.com/'), mixedResolver)).rejects.toThrow('mạng riêng');

    const publicResolver: PublicAddressLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    await expect(resolvePublicHttpsUrl(new URL('https://public.example.com/'), publicResolver)).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it('rejects a DNS answer whose family does not match its address', async () => {
    const resolver: PublicAddressLookup = async () => [{ address: '127.0.0.1', family: 6 }];
    await expect(resolvePublicHttpsUrl(new URL('https://mismatched.example.com/'), resolver)).rejects.toThrow('mạng riêng');
  });
});
