import { networkInterfaces } from 'node:os';

export function detectLocalIp(): string | null {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

export function buildLocalUrl(ip: string, port: number): string {
  const hostname = ip.replace(/\./g, '-') + '.bridge.myraildepot.com';
  return `https://${hostname}:${port}`;
}
