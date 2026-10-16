import { z } from "zod";

/**
 * Cursor pagination. Ids are UUIDv7 (time-ordered), so "newest first" is `id desc` and
 * the cursor is the last id of the previous page.
 */
export const pageQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function pageArgs(query: { cursor?: string; limit: number }) {
  return {
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: { id: "desc" as const },
  };
}

export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
