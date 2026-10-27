import { HttpStatus } from "@nestjs/common";
import { AppError } from "../../common/errors";

/** A merchant that isn't active yet (or any more) asked for something only active merchants get. */
export function merchantNotActive(status: string) {
  const message =
    status === "SUSPENDED"
      ? "This merchant account is suspended. Contact Paira Express support."
      : "Your merchant account isn't verified yet. This opens once Paira Express approves your business verification.";
  return new AppError("MERCHANT_NOT_ACTIVE", message, HttpStatus.FORBIDDEN, { status });
}
