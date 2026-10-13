import {Role} from "@shared/roles";

export type SessionUserType = {
    id: number;
    username: string;
    /** Role names, including app-defined roles. */
    roles: Role[];
};

export enum UserAuthState {
    AUTHENTICATED = "authenticated",
    LOGIN = "login",
    OTP = "otp",
    SETUP = "setup",
    SETUP_VERIFY = "setup-verify",
}

/** Structural shape of the stack's base Role model. */
export type PrismaRoleType = {
    id: number;
    name: string;
};

/**
 * Structural shape of a User row including roles, matching the stack's base
 * Prisma models. Apps may extend the User model with extra columns; those
 * are invisible here but preserved at runtime.
 */
export type PrismaUserType = {
    id: number;
    username: string;
    password: string;
    /** SHA-256 of the user's API key; null until the user issues one. */
    apiKey: string | null;
    otpSecret: string | null;
    otpEnabled: boolean;
    /** Last accepted TOTP time step (replay protection). */
    otpLastUsedStep: number | null;
    createdAt: Date;
    updatedAt: Date;
    roles: {
        id: number;
        userId: number;
        roleId: number;
        role: PrismaRoleType;
    }[];
};

export type UserStatusType = {
    user: SessionUserType | null;
    authState: UserAuthState;
};
