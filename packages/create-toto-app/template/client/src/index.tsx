import {createRoot} from 'react-dom/client';
import App from '@client/AppRouter';
import '@client/styles/globals.css';
import {UserProvider} from "toto-stack/client";

const container = document.getElementById('root');
if (!container) throw new Error('Root container not found');

const root = createRoot(container);

root.render(
    <UserProvider>
        <App/>
    </UserProvider>
);
