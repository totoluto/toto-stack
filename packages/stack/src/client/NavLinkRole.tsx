import {ReactNode} from "react";
import {NavLink} from "react-router";
import {hasAnyRole, Role} from "../shared/roles";
import {useUser} from "./UserProvider";

type NavLinkRoleProps = {
    to: string;
    /**
     * Roles that may see the link (see hasAnyRole: owner satisfies every
     * role, admin every role but owner). `[]` or omitted: any signed-in user.
     */
    requiredRoles?: readonly Role[];
    children: ReactNode;
    callback?: () => void;
    end?: boolean;
};

/** A NavLink rendered only for signed-in users holding one of `requiredRoles`. */
export const NavLinkRole = ({to, requiredRoles = [], children, callback, end}: NavLinkRoleProps) => {
    const {user} = useUser();

    if (!user || !hasAnyRole(user.roles, requiredRoles)) return null;

    return (
        <NavLink to={to} end={end} onClick={callback}>
            {children}
        </NavLink>
    );
};
