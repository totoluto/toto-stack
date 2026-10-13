import crypto from "node:crypto";
import {PrismaUserType} from "@shared/types/user";
import {Logger} from "@server/libs/Logger";
import type {StackState} from "@server/libs/Dependencies";
import type {FirstOwnerInput, UserService} from "@server/libs/services/UserService";

/**
 * First-run owner setup.
 *
 * Setup requires a setup token: `security.setupToken` / SETUP_TOKEN, or, when
 * none is configured and no user exists at boot, a random one-time token.
 * The generated token is written straight to stderr, once, so it is visible
 * whatever the log level or log transport; the logger only gets a notice
 * without the token, so it doesn't end up in log pipelines. Tokens are compared in constant time. The owner is
 * created atomically (UserService.createFirstOwner), so concurrent setups
 * yield exactly one owner even across instances. `state.setupComplete` is
 * only a cache: until it is true, every check asks the database.
 *
 * Several instances without SETUP_TOKEN each generate their own token, so
 * set SETUP_TOKEN for multi-instance deployments.
 */
export class SetupService {
    private readonly logger = new Logger("Setup");
    private generatedToken: string | undefined;

    constructor(
        private readonly userService: UserService,
        private readonly state: StackState,
        private readonly configuredToken: string | undefined,
    ) {}

    /** Reads the setup state from the database; generates and logs a one-time token if needed. Called while the app is built. */
    public async initialize(): Promise<void> {
        this.state.setupComplete = await this.userService.hasAnyUsers();

        if (this.state.setupComplete || this.configuredToken !== undefined || this.generatedToken !== undefined) {
            return;
        }

        this.generatedToken = crypto.randomBytes(24).toString("base64url");
        process.stderr.write([
            "",
            "toto-stack: no user exists yet. Create the owner account in the app with this one-time setup token:",
            "",
            `    ${this.generatedToken}`,
            "",
            "It is valid until setup completes or the server restarts. Set SETUP_TOKEN to choose your own.",
            "",
            "",
        ].join("\n"));
        this.logger.warn("No user exists yet: a one-time setup token was printed to stderr (set SETUP_TOKEN to choose your own).");
    }

    /** True once a user exists. Cached once true; re-checked in the database until then. */
    public async isComplete(): Promise<boolean> {
        if (!this.state.setupComplete && await this.userService.hasAnyUsers()) {
            this.markComplete();
        }

        return this.state.setupComplete;
    }

    /** Constant-time check of a submitted setup token. */
    public verifyToken(candidate: string): boolean {
        const active = this.activeToken();
        return active !== undefined && constantTimeEqual(digest(candidate), digest(active));
    }

    /**
     * A fingerprint of the active token, stored in the setup session. The
     * session stays valid only while that token is active (a restart with a
     * generated token, or a changed SETUP_TOKEN, invalidates pending setups).
     */
    public tokenFingerprint(): string | undefined {
        const active = this.activeToken();
        return active === undefined ? undefined : digest(`fingerprint:${active}`).toString("base64url");
    }

    public fingerprintMatches(fingerprint: string): boolean {
        const current = this.tokenFingerprint();
        return current !== undefined && constantTimeEqual(Buffer.from(current), Buffer.from(fingerprint));
    }

    /** Creates the owner. Returns null if setup was completed meanwhile (by a concurrent request or another instance). */
    public async completeSetup(input: FirstOwnerInput): Promise<PrismaUserType | null> {
        const owner = await this.userService.createFirstOwner(input);

        if (owner) {
            this.logger.info(`Setup completed: owner account "${owner.username}" created.`);
        }

        // Success or lost race: either way an owner exists now.
        this.markComplete();
        return owner;
    }

    private markComplete(): void {
        this.state.setupComplete = true;
        this.generatedToken = undefined;
    }

    private activeToken(): string | undefined {
        if (this.state.setupComplete) return undefined;
        return this.configuredToken ?? this.generatedToken;
    }
}

function digest(value: string): Buffer {
    return crypto.createHash("sha256").update(value).digest();
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}
