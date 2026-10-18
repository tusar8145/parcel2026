import type { Db } from "../../common/prisma.service";
import { OPEN_APPLICATION_STATUSES } from "./applications.schemas";

/**
 * The APPLICANT role: someone who applied to ride or run a franchise sees only the application page
 * (/application) until they are approved, like a merchant waiting for verification. Approval gives
 * the real role (RIDER, FRANCHISE), which takes priority in PANEL_FOR_ROLE; the APPLICANT grant is
 * then removed.
 */
export async function grantApplicant(db: Db, userId: string) {
  const has = await db.userRole.findFirst({ where: { userId, role: "APPLICANT" }, select: { id: true } });
  if (!has) await db.userRole.create({ data: { userId, role: "APPLICANT" } });
}

/** Removes the APPLICANT grant unless another application of this person is still being reviewed. */
export async function releaseApplicant(db: Db, userId: string) {
  const open = await db.partnerApplication.count({ where: { applicantId: userId, status: { in: [...OPEN_APPLICATION_STATUSES] } } });
  if (open) return false;
  const removed = await db.userRole.deleteMany({ where: { userId, role: "APPLICANT" } });
  return removed.count > 0;
}
