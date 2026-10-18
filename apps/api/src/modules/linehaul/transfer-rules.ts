/** Pure helpers of the bulk transfer file (shared by the bulk planner and TransferService). */

/** "BG-261018-0001" in a Bag cell (also "BG-261018-0001 → Chattogram Hub · NORTH-1" from the dropdown). */
export const bagNumberOf = (value: string | null | undefined) => value?.trim().match(/^(BG-\d{6}-\d+)\b/i)?.[1].toUpperCase() ?? null;
/** A new bag's grouping label: letters, digits, spaces and - _ / . # (at most 40). */
export const BAG_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _\-/.#]{0,39}$/;
