import {ReactElement, Suspense} from "react";
import {BrowserRouter, Navigate, Route, Routes} from "react-router";
import {LoadingScreen} from "@client/components/LoadingScreen";
import {useUser} from "toto-stack/client";
import {AuthComponent} from "@client/pages/Auth";
import {AppLayout} from "@client/components/AppLayout";
import {hasAnyRole, Role, UserAuthState} from "toto-stack/shared";
import {NoPermission} from "@client/pages/NoPermission";
import {NotFound} from "@client/pages/NotFound";
import {publicRoutes, adminRoutes} from "@client/AppRoutes";

/**
 * Protected route wrapper - requires authentication and RBAC
 */
function ProtectedRoute({element, userRoles, requiredRoles}: {
    element: ReactElement;
    userRoles: Role[];
    requiredRoles: Role[];
}) {
    const hasAccess = hasAnyRole(userRoles, requiredRoles);
    return !hasAccess ? <NoPermission /> : element;
}

/**
 * Admin layout group - authenticated users only
 */
function AdminLayout() {
    const {loading, authStage, user} = useUser();
    const userRoles = user?.roles ?? [];

    if (loading) return <LoadingScreen show={true} />;
    if (authStage !== UserAuthState.AUTHENTICATED) return <Navigate to="/login" replace />;

    return (
        <AppLayout>
            <Routes>
                {adminRoutes.map((route, key) => (
                    <Route
                        key={key}
                        index={route.index}
                        path={route.path}
                        element={<ProtectedRoute element={route.element} userRoles={userRoles} requiredRoles={route.requiredRoles} />}
                    />
                ))}
                <Route path="*" element={<NotFound />} />
            </Routes>
        </AppLayout>
    );
}

/**
 * Public layout group - accessible to everyone
 */
function PublicLayout() {
    return (
        <Suspense fallback={<LoadingScreen show={true} />}>
            <Routes>
                {publicRoutes.map((route, key) => (
                    <Route
                        key={key}
                        index={route.index}
                        path={route.path}
                        element={route.element}
                    />
                ))}
                <Route path="*" element={<NotFound />} />
            </Routes>
        </Suspense>
    );
}

/**
 * Authentication gate - unauthenticated users see login
 */
function AuthGate() {
    const {loading, authStage} = useUser();

    if (loading) return <LoadingScreen show={true} />;
    if (authStage !== UserAuthState.AUTHENTICATED) return <AuthComponent />;

    return <Navigate to="/admin" replace />;
}

/**
 * Root router - composes public, auth, and admin route groups
 */
export default function AppRouter() {
    return (
        <BrowserRouter>
            <Routes>
                {/* Public routes */}
                <Route path="/" element={<PublicLayout />} />

                {/* Auth flow */}
                <Route path="/login" element={<AuthGate />} />

                {/* Admin protected routes with sidebar */}
                <Route path="/admin/*" element={<AdminLayout />} />

                {/* Fallback */}
                <Route path="*" element={<NotFound />} />
            </Routes>
        </BrowserRouter>
    );
}
