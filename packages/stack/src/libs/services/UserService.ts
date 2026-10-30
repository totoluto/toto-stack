import crypto from "node:crypto";
import {Role} from "@shared/roles";
import {PrismaUserType} from "@shared/types/user";
import {SESSION_USER_SELECT, StackPrismaClient, type StackSessionUser} from "@server/libs/prisma/StackPrismaClient";
import {PasswordHasher, PasswordHasherOptions} from "@server/libs/security/PasswordHasher";
import {AppError} from "@server/libs/ErrorHandler";
import {Logger} from "@server/libs/Logger";
import {ErrorCode} from "@shared/errorCodes";

/** Recognisable prefix of API keys (secret scanners can match `toto_` + 43 base64url characters). */
export const API_KEY_PREFIX = "toto_";
const API_KEY_PATTERN = /^toto_[A-Za-z0-9_-]{43}$/;

const INCLUDE_ROLES = {roles: {include: {role: true}}} as const;

export type FirstOwnerInput = {
    username: string;
    /** Already hashed (PasswordHasher format). */
    passwordHash: string;
    /** The stored (possibly sealed) TOTP secret. */
    otpSecret: string;
    /** The TOTP step used to confirm enrollment (replay protection). */
    otpLastUsedStep: number;
};

/** User accounts, credentials and API keys. */
export class UserService {
    private readonly hasher: PasswordHasher;
    private readonly logger = new Logger("UserService");

    public constructor(private readonly prisma: StackPrismaClient, hashing: PasswordHasherOptions = {}) {
        this.hasher = new PasswordHasher(hashing);
    }

    public hashApiKey(apiKey: string): string {
        return crypto.createHash("sha256").update(apiKey).digest("base64url");
    }

    public hashPassword(password: string): Promise<string> {
        return this.hasher.hash(password);
    }

    /**
     * Creates a user without an API key (users issue their own keys).
     * Throws AppError(409) when the username is taken.
     */
    public async createUser(username: string, password: string, roles: readonly Role[] = []): Promise<PrismaUserType> {
        const passwordHash = await this.hasher.hash(password);

        try {
            return await this.prisma.user.create({
                data: {
                    username,
                    password: passwordHash,
                    roles: {create: [...new Set(roles)].map(role => ({role: {connect: {name: role}}}))},
                },
                include: INCLUDE_ROLES,
            });
        } catch (err) {
            throw mapUniqueViolation(err);
        }
    }

    /**
     * Creates the first owner atomically. Inside one transaction it re-checks
     * that no user exists, creates the owner, and inserts the singleton
     * SetupLock row (fixed primary key 1). A concurrent second setup fails
     * (on that primary key, the username, or the database's write-conflict
     * check) and rolls back, whatever the isolation level. Returns null if
     * another setup won or users already exist; other errors are rethrown.
     */
    public async createFirstOwner(input: FirstOwnerInput): Promise<PrismaUserType | null> {
        try {
            return await this.prisma.$transaction(async tx => {
                if ((await tx.user.count()) > 0) {
                    return null;
                }

                const user = await tx.user.create({
                    data: {
                        username: input.username,
                        password: input.passwordHash,
                        otpEnabled: true,
                        otpSecret: input.otpSecret,
                        otpLastUsedStep: input.otpLastUsedStep,
                        roles: {create: [{role: {connect: {name: Role.OWNER}}}]},
                    },
                    include: INCLUDE_ROLES,
                });

                await tx.setupLock.create({data: {id: 1, userId: user.id}});
                return user;
            });
        } catch (err) {
            // The loser of a concurrent setup fails in a database-specific way:
            // P2002 on the lock row or the username, a write conflict (MariaDB
            // >= 11.6 with innodb_snapshot_isolation: error 1020 / P2039), or a
            // deadlock. Rather than matching codes, ask the database: if a user
            // exists now, setup was completed elsewhere. Otherwise it's a real error.
            if (await this.hasAnyUsers().catch(() => false)) {
                return null;
            }

            throw err;
        }
    }

    /** Deletes a user (cascading roles and sessions). Returns false if it no longer exists (e.g. a concurrent delete). */
    public async deleteUser(userID: number): Promise<boolean> {
        try {
            await this.prisma.user.delete({where: {id: userID}, include: {roles: true}});
            return true;
        } catch (err) {
            if (typeof err === "object" && err !== null && (err as {code?: unknown}).code === "P2025") {
                return false;
            }
            throw err;
        }
    }

    /** The full user (credentials included), for login. */
    public async getByUsername(username: string): Promise<PrismaUserType | null> {
        return this.prisma.user.findFirst({where: {username}, include: INCLUDE_ROLES});
    }

    /** The full user (credentials included), for MFA and password checks. */
    public async getById(userID: number): Promise<PrismaUserType | null> {
        return this.prisma.user.findFirst({where: {id: userID}, include: INCLUDE_ROLES});
    }

    /** Id, username and role names only (no credential columns), for authentication and authorization checks. */
    public async getSessionUser(userID: number): Promise<StackSessionUser | null> {
        return this.prisma.user.findUnique({where: {id: userID}, select: SESSION_USER_SELECT});
    }

    /**
     * Looks a Bearer key up by its SHA-256 (unique index); loads no credential
     * columns. Malformed keys never reach the database.
     */
    public async getByApiKey(apiKey: string): Promise<StackSessionUser | null> {
        if (!API_KEY_PATTERN.test(apiKey)) {
            return null;
        }

        return this.prisma.user.findUnique({where: {apiKey: this.hashApiKey(apiKey)}, select: SESSION_USER_SELECT});
    }

    public async hasAnyUsers(): Promise<boolean> {
        return (await this.prisma.user.count()) > 0;
    }

    public async listUsers(): Promise<{id: number; username: string; otpEnabled: boolean; createdAt: Date; roles: PrismaUserType['roles']}[]> {
        return this.prisma.user.findMany({
            select: {
                id: true,
                username: true,
                otpEnabled: true,
                createdAt: true,
                roles: {include: {role: true}},
            },
        });
    }

    /**
     * Checks a password against the user's hash. Argon2id hashes with other
     * parameters than the configured ones are replaced by a current hash
     * after a successful check;
     * `user.password` is updated to the stored value.
     */
    public async verifyPassword(user: Pick<PrismaUserType, "id" | "password">, password: string): Promise<boolean> {
        const {valid, needsRehash} = await this.hasher.verify(password, user.password);

        if (valid && needsRehash) {
            try {
                const upgraded = await this.hasher.hash(password);
                await this.prisma.user.update({where: {id: user.id}, data: {password: upgraded}});
                user.password = upgraded;
            } catch (err) {
                // The login itself succeeded; the next one retries the upgrade.
                this.logger.warn(`Could not upgrade the password hash of user ${user.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        return valid;
    }

    /** Same cost as verifyPassword, for unknown usernames (no timing difference). Always false. */
    public verifyDummyPassword(password: string): Promise<false> {
        return this.hasher.verifyDummy(password);
    }

    /** Sets a new password and revokes the user's API key (a credential change invalidates derived credentials). */
    public async updatePassword(userId: number, newPassword: string): Promise<void> {
        const password = await this.hasher.hash(newPassword);
        await this.prisma.user.update({where: {id: userId}, data: {password, apiKey: null}});
    }

    /**
     * Issues a new API key for the user, replacing any previous one. The
     * plaintext (`toto_` + 32 random bytes, base64url) is returned once; only
     * its SHA-256 is stored.
     */
    public async issueApiKey(userId: number): Promise<string> {
        const plainApiKey = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
        await this.prisma.user.update({where: {id: userId}, data: {apiKey: this.hashApiKey(plainApiKey)}});

        return plainApiKey;
    }

    public async revokeApiKey(userId: number): Promise<void> {
        await this.prisma.user.update({where: {id: userId}, data: {apiKey: null}});
    }

    /**
     * Records a used TOTP step if it is newer than the last one, atomically
     * (conditional update). Returns false when the step was already used,
     * e.g. by a concurrent request with the same code. `otpSecret` re-stores
     * the secret in the same write (used to encrypt a secret stored in
     * plaintext before an encryption key was configured).
     */
    public async recordOtpStep(userId: number, step: number, otpSecret?: string): Promise<boolean> {
        const {count} = await this.prisma.user.updateMany({
            where: {
                id: userId,
                otpEnabled: true,
                OR: [{otpLastUsedStep: null}, {otpLastUsedStep: {lt: step}}],
            },
            data: {otpLastUsedStep: step, ...(otpSecret !== undefined ? {otpSecret} : {})},
        });

        return count === 1;
    }

    /** Enables MFA with an enrolled secret. Returns false if MFA was already enabled (e.g. a concurrent enrollment). */
    public async enableMfa(userId: number, otpSecret: string, otpLastUsedStep: number): Promise<boolean> {
        const {count} = await this.prisma.user.updateMany({
            where: {id: userId, otpEnabled: false},
            data: {otpEnabled: true, otpSecret, otpLastUsedStep},
        });

        return count === 1;
    }

    public async disableMfa(userId: number): Promise<void> {
        await this.prisma.user.update({
            where: {id: userId},
            data: {otpEnabled: false, otpSecret: null, otpLastUsedStep: null},
        });
    }

    public async revokeSession(userId: number, sessionID: string): Promise<void> {
        await this.prisma.session.deleteMany({
            where: {
                userId,
                id: sessionID
            },
        });
    }

    public async revokeOtherSessions(userId: number, keepSessionId?: string): Promise<void> {
        await this.prisma.session.deleteMany({
            where: {
                userId,
                ...(keepSessionId ? {id: {not: keepSessionId}} : {}),
            },
        });
    }
}

function isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as {code?: unknown}).code === "P2002";
}

/** P2002 on create (concurrent duplicate username) becomes a 409 instead of a 500. */
function mapUniqueViolation(err: unknown): unknown {
    return isUniqueViolation(err) ? new AppError(409, "Username already exists.", {code: ErrorCode.USERNAME_TAKEN, cause: err}) : err;
}
