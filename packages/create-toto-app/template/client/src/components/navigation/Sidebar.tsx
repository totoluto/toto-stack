import {useState} from "react";
import "@client/styles/sidebar.css";
import {NavLinkRole} from "toto-stack/client";
import {adminRoutes} from "@client/AppRoutes";
import logo from "@client/assets/logo.svg"
import {FaCog} from "react-icons/fa";
import {FiLogOut} from "react-icons/fi";
import {useUser} from "toto-stack/client";
import {UserAuthState} from "toto-stack/shared";

const APP_NAME = "Stack";

export function Sidebar() {
    const [mobileOpen, setMobileOpen] = useState(false);
    const {authStage, logout} = useUser();

    function renderRoute(route: typeof adminRoutes[number]) {
        return (
            <NavLinkRole
                callback={() => setMobileOpen(false)}
                key={route.label}
                to={route.index ? "/admin" : `/admin/${route.path}`}
                end={route.index}
                requiredRoles={route.requiredRoles}
            >
                {route.icon}{route.label}
            </NavLinkRole>
        );
    }

    function handleLogout() {
        if (authStage === UserAuthState.AUTHENTICATED) {
            void logout();
        }
    }

    return (
        <>
            <button
                className={`burger ${mobileOpen ? 'open' : ''}`}
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
                aria-expanded={mobileOpen}
                type="button"
            >
                <span></span>
                <span></span>
                <span></span>
            </button>
            <header className="mobile-nav-header">
                <div className="mobile-brand">
                    <img src={logo} alt="" aria-hidden="true" />
                    <span>{APP_NAME}</span>
                </div>
            </header>
            <div
                className={`sidebar-backdrop ${mobileOpen ? "open" : ""}`}
                onClick={() => setMobileOpen(false)}
                aria-hidden="true"
            />
            <nav className={`sidebar ${mobileOpen ? "open" : ""}`} aria-label="Main">
                <div className="logo-container">
                    <img src={logo} alt="App Logo" />
                    <h1 className="app-name">{APP_NAME}</h1>
                </div>
                <div className="nav-links">
                    {adminRoutes.filter((route) => !route.hidden).map(renderRoute)}
                </div>
                <span className={'spacer'}/>
                <div className="nav-links">
                    <NavLinkRole
                        callback={() => setMobileOpen(false)}
                        to={'/admin/settings'}
                        requiredRoles={[]}
                    >
                        <FaCog size={24} aria-hidden="true"/> Settings
                    </NavLinkRole>
                    <button type="button" className="nav-link-button" onClick={handleLogout}>
                        <FiLogOut size={24} aria-hidden="true"/>Logout
                    </button>
                </div>
            </nav>
        </>
    );
}
