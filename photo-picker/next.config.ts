import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * Next's dev server blocks cross-origin requests to /_next/* resources unless
 * the requesting host is allowlisted. Loading the app on an iPhone at
 * http://192.168.x.x:3000 (or through an HTTPS tunnel) is exactly that case:
 * the page HTML loads but every JS chunk comes back 403 and the app never
 * hydrates — the file picker silently does nothing.
 *
 * So allow the hosts this app is actually meant to be reached on in dev.
 * `allowedDevOrigins` matching is dot-segment based, so `*` works per IPv4
 * octet.
 */
function devOrigins(): string[] {
  const origins = new Set<string>([
    "localhost",
    "127.0.0.1",
    // Bonjour names, e.g. http://my-macbook.local:3000
    "*.local",
    // Private ranges, so a second interface (VPN, Ethernet) still works.
    "10.*.*.*",
    "172.*.*.*",
    "192.168.*.*",
    // Tunnels, for the HTTPS-on-device path.
    "**.trycloudflare.com",
    "**.ngrok-free.app",
    "**.ngrok.io",
    "**.ngrok.app",
    "**.loca.lt",
    "**.tailscale.net",
    "**.ts.net",
  ]);

  // Whatever this machine's actual LAN addresses are.
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) origins.add(address.address);
    }
  }

  // Escape hatch: ALLOWED_DEV_ORIGINS="foo.example.com,203.0.113.5"
  for (const extra of (process.env.ALLOWED_DEV_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }

  return [...origins];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
};

export default nextConfig;
