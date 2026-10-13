import {lazy, ReactElement} from "react";
import {Role} from "toto-stack/shared";
import {FaCog, FaHome} from "react-icons/fa";

const Landing = lazy(() => import("@client/pages/Landing"));
const Dashboard = lazy(() => import("@client/pages/Dashboard"));
const SettingsPage = lazy(() => import("@client/pages/Settings"));

export type RouteDefinition = {
    label: string;
    icon: ReactElement;
    path?: string;
    element: ReactElement;
    requiredRoles: Role[];
    index?: boolean;
    hidden?: boolean;
};

export const publicRoutes: RouteDefinition[] = [
    {
        label: 'Home',
        icon: <FaHome size={24} />,
        index: true,
        path: "/",
        element: <Landing />,
        requiredRoles: [],
    },
];

export const adminRoutes: RouteDefinition[] = [
    {
        label: 'Dashboard',
        icon: <FaHome size={24}/>,
        index: true,
        element: <Dashboard />,
        requiredRoles: [],
    },
    {
        label: 'Settings',
        icon: <FaCog size={24} />,
        path: "settings",
        element: <SettingsPage />,
        requiredRoles: [],
        hidden: true,
    },
];
