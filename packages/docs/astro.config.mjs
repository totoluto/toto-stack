import {defineConfig} from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc, {typeDocSidebarGroup} from 'starlight-typedoc';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
    site: 'https://totoluto.github.io',
    base: '/toto-stack',
    trailingSlash: 'always',
    integrations: [starlight({
        title: 'toto-stack',
        description: 'Build, extend and deploy secure full-stack TypeScript applications.',
        social: [{icon: 'github', label: 'GitHub', href: 'https://github.com/totoluto/toto-stack'}],
        editLink: {baseUrl: 'https://github.com/totoluto/toto-stack/edit/master/packages/docs/'},
        customCss: ['./src/styles/custom.css'],
        components: {SiteTitle: './src/components/SiteTitle.astro'},
        plugins: [
            starlightTypeDoc({
                entryPoints: ['../stack/src/index.ts', '../stack/src/client.ts', '../stack/src/shared.ts'],
                tsconfig: '../stack/tsconfig.json',
                sidebar: {label: 'TypeScript API', collapsed: true},
                typeDoc: {
                    name: 'Public API',
                    readme: 'none',
                    entryFileName: 'index.md',
                    excludeExternals: true,
                    excludePrivate: true,
                    excludeProtected: false,
                    sort: ['kind', 'alphabetical'],
                },
            }),
            starlightLinksValidator(),
        ],
        sidebar: [
            {label: 'Start here', items: [{autogenerate: {directory: 'start'}}]},
            {label: 'Build your app', items: [{autogenerate: {directory: 'guides'}}]},
            {label: 'Configure & deploy', items: [{autogenerate: {directory: 'operate'}}]},
            {label: 'HTTP API', items: [{autogenerate: {directory: 'http'}}]},
            typeDocSidebarGroup,
            {label: 'CLI reference', slug: 'reference/cli'},
            {label: 'Maintain', items: [{autogenerate: {directory: 'maintain'}}]},
        ],
    })],
});
