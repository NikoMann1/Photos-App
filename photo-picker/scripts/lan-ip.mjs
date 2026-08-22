/**
 * Prints this machine's LAN IPv4 address — the one an iPhone on the same wifi
 * can reach. Used by the `dev:lan` / `dev:https` scripts.
 *
 * `next dev --experimental-https` only puts the host passed to `-H` in the
 * certificate's SANs, so HTTPS on the LAN needs the real IP here, not 0.0.0.0.
 */
import { networkInterfaces } from "node:os";

const candidates = [];
for (const [name, addresses] of Object.entries(networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (address.family !== "IPv4" || address.internal) continue;
    // 169.254.x.x is link-local (no DHCP) — never the wifi address you want.
    if (address.address.startsWith("169.254.")) continue;
    candidates.push({ name, ip: address.address });
  }
}

// On a Mac, wifi is en0/en1; prefer those over VPN and virtual interfaces.
const preferred =
  candidates.find((c) => /^en\d/.test(c.name)) ??
  candidates.find((c) => /^(wl|wlan|eth)/.test(c.name)) ??
  candidates[0];

if (!preferred) {
  console.error("No LAN IPv4 address found — are you connected to wifi?");
  process.exit(1);
}

process.stdout.write(preferred.ip);
