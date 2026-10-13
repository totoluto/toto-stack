/**
 * Client entry point, browser-safe React building blocks.
 * Import via "toto-stack/client".
 */
export {apiFetch, clearCsrfToken, configureApiClient, ApiError} from "./client/helpers";
export type {ApiClientOptions, ApiFetchOptions, ApiErrorCode} from "./client/helpers";
export {UserProvider, UserContext, useUser} from "./client/UserProvider";
export type {UserContextType} from "./client/UserProvider";
export {NavLinkRole} from "./client/NavLinkRole";

// Re-export the shared roles/types most client code needs alongside these components
export {Role, BUILTIN_ROLES, hasAnyRole, canGrantRole} from "./shared/roles";
export type {BuiltinRole} from "./shared/roles";
export {UserAuthState} from "./shared/types/user";
export type {SessionUserType, UserStatusType} from "./shared/types/user";
export type {WebResponse, WebErrorResponse} from "./shared/types/web";
export {ErrorCode} from "./shared/errorCodes";
