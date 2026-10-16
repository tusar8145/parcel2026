import { z } from "zod";
import type { Actor } from "../../common/auth/actor";
import { forbidden } from "../../common/errors";
import { normalizeTrackingId } from "../../common/counters";
import { opsHubScope } from "../parcels/ops-scope";
import type { Prisma } from "../../generated/prisma/client";

/**
 * Small helpers shared by the courier operations modules (linehaul, CN stock, SLA, scans,
 * shifts, reports, routing).
 */

/** Throws 403 unless the actor may act at `hubId` (hub operators: their own hubs only). */
export function assertHubInScope(actor: Actor, hubId: string | null | undefined, action = "act at this hub") {
  const scope = opsHubScope(actor);
  if (!scope || (hubId && scope.includes(hubId))) return;
  throw forbidden(`Only that hub's staff or an operations manager can ${action}`);
}

/** True when the actor may act at one of the given hubs. */
export function inHubScope(actor: Actor, ...hubIds: (string | null | undefined)[]) {
  const scope = opsHubScope(actor);
  return !scope || hubIds.some(h => !!h && scope.includes(h));
}

/** The candidates a typed or scanned tracking ID / CN may stand for (case, spaces, Crockford look-alikes). */
export function codeVariants(input: string): string[] {
  const typed = input.trim().toUpperCase().replace(/^\*+|\*+$/g, "");
  return [...new Set([typed, normalizeTrackingId(typed)])];
}

/** A pickup request waiting for a pickup rider. Drop-off parcels are brought to a hub instead and never need one. */
export const NEEDS_PICKUP_RIDER = { status: "PENDING_CONFIRMATION", intake: "PICKUP" } as const satisfies Prisma.ParcelWhereInput;

export const isUuid =(value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export const scanSourceSchema = z.enum(["CAMERA", "KEYBOARD", "MANUAL"]).default("KEYBOARD");
export const boolQuery = z.enum(["true", "false"]).transform(v => v === "true");
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform(v => v || undefined);

/** Dhaka calendar day "YYYY-MM-DD" of an instant. */
export const dhakaDay = (d = new Date()) => new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10);

/**
 * Excel-compatible CSV (UTF-8 with BOM, CRLF). Cells that a spreadsheet would run as a
 * formula (=, +, -, @ at the start) are prefixed with an apostrophe.
 */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (value: string | number | null | undefined) => {
    if (value == null) return "";
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${[header, ...rows].map(r => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
