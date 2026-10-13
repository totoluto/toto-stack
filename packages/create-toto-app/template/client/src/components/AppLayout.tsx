import { ReactNode, Suspense } from "react";
import "@client/styles/layout.css";
import { LoadingScreen } from "@client/components/LoadingScreen";
import { Outlet } from "react-router";
import { Sidebar } from "@client/components/navigation/Sidebar";

interface AppLayoutProps {
    children?: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
    return (
        <div className={'main-container'}>
            <Sidebar/>
            <div className={'outlet-content'}>
                <Suspense fallback={<LoadingScreen show={true} />}>
                    {children ?? <Outlet />}
                </Suspense>
            </div>
        </div>
    )
}