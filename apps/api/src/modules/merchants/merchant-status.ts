import { HttpStatus } from "@nestjs/common";
import { AppError } from "../../common/errors";

/** A merchant that isn't active yet (or any more) asked for something only active merchants get. */
export function merchantNotActive(status: string) {
  const message =
    status === "SUSPENDED"
      ? "This merchant account is suspended. Contact Delivery Fast support."
      : "Your merchant account isn't verified yet. This opens once Delivery Fast approves your business verification.";
  return new AppError("MERCHANT_NOT_ACTIVE", message, HttpStatus.FORBIDDEN, { status });
}
