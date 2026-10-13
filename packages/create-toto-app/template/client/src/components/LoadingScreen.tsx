import "@client/styles/loadingScreen.css"
import logo from "@client/assets/logo.svg"

type LoadingScreenProps = {
    show: boolean;
};

export function LoadingScreen({ show }: LoadingScreenProps) {
    if (!show) return null;

    return (
        <div className="loading-screen" role="status" aria-live="polite">
            <img src={logo} alt="" className="logo" />

            <div className="loader-body" aria-hidden="true">
                <div className="loader-body_dot" />
                <div className="loader-body_dot" />
                <div className="loader-body_dot" />
            </div>

            <div className="message">Loading</div>
        </div>
    );
}
