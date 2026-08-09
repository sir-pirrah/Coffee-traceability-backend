import { z } from "zod";

/**
 * Exported because every place a password is *chosen* has to apply the same
 * rules — registration, the change-password endpoint, and the frontend mirror.
 * A second copy would drift, and the copy that drifts is always the weaker one.
 */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain a special character");

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email().toLowerCase(),
    password: passwordSchema,
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phoneNumber: z.string().min(7).max(20).optional(),
    // SUPER_ADMIN is absent by design: this endpoint is reachable only by an
    // authenticated administrator, and which of these a given caller may
    // actually grant is narrowed again in the service against their own role.
    role: z.enum(["COOPERATIVE_ADMIN", "COOPERATIVE_STAFF", "FARMER", "BUYER"]),
    cooperativeId: z.string().uuid().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const loginSchema = z.object({
  body: z.object({
    // One field, not three. A farmer types the code printed on their slip, staff
    // type their email, and either may type a phone number — the shape is sorted
    // out in `classifyIdentifier`, not by asking the user which kind it is.
    identifier: z.string().trim().min(1, "Enter your email, phone number or farmer code").max(255),
    password: z.string().min(1),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>["body"];
export type LoginInput = z.infer<typeof loginSchema>["body"];
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>["body"];
