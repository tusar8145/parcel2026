import { z } from "zod";
import { isBdMobile, isMaskedBdMobile, normalizeBdPhone, normalizeMaskedBdPhone } from "../phone";

export const phoneSchema = z
  .string()
  .trim()
  .refine(isBdMobile, "Enter a valid Bangladeshi mobile number, e.g. 01712-345678")
  .transform(normalizeBdPhone);

/**
 * A parcel recipient's phone: a BD mobile, or one printed masked on the label ("019***545": kept as
 * written; no SMS is sent to it). Logins, senders and staff keep `phoneSchema`.
 */
export const recipientPhoneSchema = z
  .string()
  .trim()
  .refine(v => isBdMobile(v) || isMaskedBdMobile(v), "Enter a valid Bangladeshi mobile number, e.g. 01712-345678")
  .transform(v => (isBdMobile(v) ? normalizeBdPhone(v) : normalizeMaskedBdPhone(v)));

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));

/** 10+ characters with a letter and a digit. Long passphrases are preferred over symbol rules. */
export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128, "Use at most 128 characters")
  .refine(p => /[A-Za-z]/.test(p) && /\d/.test(p), "Use at least one letter and one number");

export const otpCodeSchema = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");

export const OTP_PURPOSES = ["SIGNUP", "LOGIN", "PASSWORD_RESET"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** Email or phone number. */
export const identifierSchema = z
  .string()
  .trim()
  .min(3, "Enter your email or mobile number")
  .transform(value => (value.includes("@") ? value.toLowerCase() : isBdMobile(value) ? normalizeBdPhone(value) : value));

export const requestOtpSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(OTP_PURPOSES),
});

export const signupSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(120, "Use at most 120 characters"),
  phone: phoneSchema,
  email: emailSchema.optional(),
  password: passwordSchema,
  otp: otpCodeSchema,
});

export const passwordLoginSchema = z.object({
  identifier: identifierSchema,
  password: z.string().min(1, "Enter your password").max(128, "Use at most 128 characters"),
});

export const otpLoginSchema = z.object({
  phone: phoneSchema,
  otp: otpCodeSchema,
});

export const resetPasswordSchema = z.object({
  phone: phoneSchema,
  otp: otpCodeSchema,
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(120, "Use at most 120 characters").optional(),
  email: emailSchema.nullable().optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;
