import {z} from "zod";
import type {Role} from "@shared/roles";

export const noPayloadSchema = z.union([z.undefined(), z.object({}).strict()]);
export type NoPayload = z.infer<typeof noPayloadSchema>;

/**
 * Password policy for new passwords: 10 to 256 characters. Argon2id has no
 * input-length limit; the upper bound only caps the hashing input size.
 */
const newPasswordField = z.string().min(10).max(256);
/** A password being checked (login, re-confirmation): any length up to the cap. */
const passwordField = z.string().min(1).max(256);
const usernameField = z.string().trim().min(1).max(64);
const otpField = z.string().regex(/^\d{6}$/);

export const authCredentialsSchema = z.object({
    username: usernameField,
    password: passwordField,
}).strict();

export type AuthCredentialsPayload = z.infer<typeof authCredentialsSchema>;

/** First-run setup: the owner's credentials plus the setup token. */
export const setupStartSchema = z.object({
    username: usernameField,
    password: newPasswordField,
    setupToken: z.string().min(1).max(512),
}).strict();

export type SetupStartPayload = z.infer<typeof setupStartSchema>;

export const otpTokenSchema = z.object({
    token: otpField,
}).strict();

export type OtpTokenPayload = z.infer<typeof otpTokenSchema>;

export const changePasswordSchema = z.object({
    currentPassword: passwordField,
    newPassword: newPasswordField,
}).strict();

export type ChangePasswordPayload = z.infer<typeof changePasswordSchema>;

export const passwordConfirmSchema = z.object({
    password: passwordField,
}).strict();

export type PasswordConfirmPayload = z.infer<typeof passwordConfirmSchema>;

export const revokeSessionSchema = z.object({
    password: passwordField,
    sessionID: z.string().min(1, "Session ID is required"),
}).strict();

export type RevokeSessionPayload = z.infer<typeof revokeSessionSchema>;

export const mfaDisableSchema = z.object({
    password: passwordField,
    token: otpField,
}).strict();

export type MfaDisablePayload = z.infer<typeof mfaDisableSchema>;

/**
 * Body of a "create user" request (the template's POST /api/users): a
 * username, a password following the stack's password policy and optional
 * roles, which must be configured role names (duplicates are removed).
 * Whether the caller may grant those roles is checked separately (canGrantRole).
 */
export function createUserSchema(configuredRoles: readonly Role[]) {
    const known = new Set<string>(configuredRoles);

    return z.object({
        username: usernameField,
        password: newPasswordField,
        roles: z.array(z.string().refine(role => known.has(role), {message: "Unknown role"}))
            .max(64)
            .default([])
            .transform(roles => [...new Set(roles)] as Role[]),
    }).strict();
}

export type CreateUserPayload = z.infer<ReturnType<typeof createUserSchema>>;

const notificationMetadataValue = z.union([z.string().max(1024), z.number(), z.boolean()]);

/**
 * Body of a "send notification" request (the template's POST
 * /api/notifications/send). `handlers` targets handler ids (default: all).
 */
export const sendNotificationSchema = z.object({
    title: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(2000),
    handlers: z.array(z.string().min(1).max(100)).max(50).optional(),
    metadata: z.record(z.string().min(1).max(64), notificationMetadataValue)
        .refine(record => Object.keys(record).length <= 25, {message: "At most 25 metadata entries."})
        .optional(),
}).strict();

export type SendNotificationPayload = z.infer<typeof sendNotificationSchema>;
