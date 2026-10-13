import {BaseRoute, canGrantRole, createUserSchema, ErrorCode, respond, Role, sendError, type Dependencies} from "toto-stack";

/**
 * /api/users: user management for admins and owners.
 *
 * Keep these rules when you change this route:
 * - Only an owner may grant `owner` or `admin`; an admin may grant app roles.
 * - Deleting a user requires being allowed to grant every role it holds (an
 *   admin can't delete an admin). Owners are never deleted, and nobody
 *   deletes their own account here.
 * - Responses never contain password hashes, TOTP secrets or API keys. New
 *   users have no API key; each user issues their own (/api/account/api-key).
 * - userService.createUser() turns a taken username (also when created
 *   concurrently) into a 409 USERNAME_TAKEN.
 */
export class UsersRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/users", dependencies, {roles: [Role.ADMIN]});
    }

    protected registerRoutes(): void {
        const {userService} = this.dependencies;

        this.get("/", async (_req, res) => {
            const users = await userService.listUsers();

            return respond(res, 200, "success", "Users retrieved", {
                users: users.map(user => ({
                    id: user.id,
                    username: user.username,
                    otpEnabled: user.otpEnabled,
                    createdAt: user.createdAt,
                    roles: user.roles.map(userRole => userRole.role.name),
                })),
            });
        });

        // The stack's password policy and the configured role names.
        this.post("/", createUserSchema(this.dependencies.config.roles), async (req, res, {username, password, roles}) => {
            const actor = this.currentUser(req);
            const forbidden = roles.filter(role => !canGrantRole(actor.roles, role));
            if (forbidden.length > 0) {
                return sendError(res, 403, `You may not grant the role(s): ${forbidden.join(", ")}.`, {code: ErrorCode.ROLE_NOT_GRANTABLE});
            }

            const user = await userService.createUser(username, password, roles);

            return respond(res, 201, "success", "User created", {
                user: {
                    id: user.id,
                    username: user.username,
                    roles: user.roles.map(userRole => userRole.role.name),
                },
            });
        });

        this.delete("/:id", async (req, res) => {
            const actor = this.currentUser(req);
            const userId = Number(req.params.id);
            if (!Number.isInteger(userId) || userId < 1) {
                return sendError(res, 400, "Invalid user id.", {code: ErrorCode.INVALID_USER_ID});
            }

            if (userId === actor.id) {
                return sendError(res, 400, "You cannot delete your own account.", {code: ErrorCode.CANNOT_DELETE_SELF});
            }

            const target = await userService.getById(userId);
            if (!target) {
                return sendError(res, 404, "User not found.", {code: ErrorCode.USER_NOT_FOUND});
            }

            const targetRoles = target.roles.map(userRole => userRole.role.name);
            if (targetRoles.includes(Role.OWNER)) {
                return sendError(res, 403, "Owner accounts cannot be deleted.", {code: ErrorCode.USER_PROTECTED});
            }

            if (!targetRoles.every(role => canGrantRole(actor.roles, role))) {
                return sendError(res, 403, "Only an owner can delete this user.", {code: ErrorCode.USER_PROTECTED});
            }

            // False when the user was deleted concurrently.
            if (!(await userService.deleteUser(userId))) {
                return sendError(res, 404, "User not found.", {code: ErrorCode.USER_NOT_FOUND});
            }

            return respond(res, 200, "success", "User deleted");
        });
    }
}
