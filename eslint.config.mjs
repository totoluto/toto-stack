// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Browser code: the stack's React helpers and the template's Vite client.
const STACK_CLIENT = ['packages/stack/src/client/**/*.{ts,tsx}', 'packages/stack/src/client.ts']
const TEMPLATE_CLIENT = ['packages/create-toto-app/template/client/**/*.{ts,tsx}']

export default defineConfig([
    globalIgnores([
        '**/dist',
        '**/coverage',
        '**/prisma/client',
        // The template's built client bundle (Vite outDir).
        'packages/create-toto-app/template/server/public',
    ]),
    {
        // Everything runs on Node unless listed below: server, CLI, build and
        // test scripts, tests and config files.
        files: ['**/*.{js,mjs,cjs,ts,tsx}'],
        extends: [js.configs.recommended, tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 2024,
            globals: globals.node,
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error',
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
    {
        files: [...STACK_CLIENT, ...TEMPLATE_CLIENT],
        extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
        languageOptions: {
            globals: globals.browser,
        },
    },
    {
        // Library code is consumed from npm; Vite fast-refresh constraints don't apply.
        files: STACK_CLIENT,
        rules: {
            'react-refresh/only-export-components': 'off',
        },
    },
    {
        // Type-aware promise rules for the published package: an unawaited
        // promise in a handler or service is an unhandled rejection in production.
        files: ['packages/stack/src/**/*.{ts,tsx}'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
        },
    },
])
