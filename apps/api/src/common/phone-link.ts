import os from "node:os";
import { env } from "../config/env";

/**
 * The origin of links opened on a phone (Scan with phone, Phone scanner): SCAN_LINK_ORIGIN, else
 * APP_URL. In development a localhost APP_URL becomes this computer's LAN address, so a phone on the
 * same Wi-Fi can open it.
 */
export function phoneLinkOrigin() {
  const configured = env().SCAN_LINK_ORIGIN ?? env().APP_URL;
  const url = new URL(configured);
  if (!env().SCAN_LINK_ORIGIN && env().NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    const virtual = /vethernet|wsl|docker|virtualbox|vmware|hyper-v|loopback|tailscale|zerotier/i;
    const candidates = Object.entries(os.networkInterfaces())
      .filter(([name]) => !virtual.test(name))
      .flatMap(([, list]) => list ?? [])
      .filter(a => a.family === "IPv4" && !a.internal);
    const lan = candidates.find(a => a.address.startsWith("192.168.")) ?? candidates.find(a => a.address.startsWith("10.")) ?? candidates[0];
    if (lan) url.hostname = lan.address;
  }
  return url.origin;
}
