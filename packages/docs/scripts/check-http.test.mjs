import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {extractEndpoints, collectEndpoints, documentedEndpoints, compareEndpoints} from './check-http.mjs';

const fixture = {
  server: `app.use('/api', registerSessionlessApiRoutes(deps)); app.use('/api', registerApiRoutes(deps, routes));`,
  framework: `const SESSIONLESS_ROUTES: RouteClass[] = [HealthRoute]; const BUILTIN_ROUTES: RouteClass[] = [AuthRoute];`,
  template: `export const routes: RouteClass[] = [StatusRoute];`,
  sources: {
    HealthRoute: `super('/health', deps); this.get('/', handler);`,
    AuthRoute: `super('/auth', deps); this.post('/login', schema, handler);`,
    StatusRoute: `super('/status', deps); this.get('/', handler);`,
    UnmountedRoute: `super('/unused', deps); this.get('/', handler);`,
  },
};

test('reads registered arrays and server prefixes, excluding unmounted classes', () => {
  assert.deepEqual(collectEndpoints(fixture), ['GET /api/health', 'POST /api/auth/login', 'GET /api/status']);
  assert.deepEqual(collectEndpoints({...fixture, server: fixture.server.replaceAll('/api', '/api/v2')}),
    ['GET /api/v2/health', 'POST /api/v2/auth/login', 'GET /api/v2/status']);
});

test('rejects missing registration arrays, dynamic lists, absent classes, and missing server mounts', () => {
  assert.throws(() => collectEndpoints({...fixture, framework: ''}), /SESSIONLESS_ROUTES/);
  assert.throws(() => collectEndpoints({...fixture, template: 'const routes = [...customRoutes];'}), /routes/);
  assert.throws(() => collectEndpoints({...fixture, sources: {}}), /HealthRoute/);
  assert.throws(() => collectEndpoints({...fixture, server: ''}), /registerSessionlessApiRoutes/);
});

test('counts only endpoint headings outside fenced examples, preserving duplicates', () => {
  const markdown = [
    '### `GET /api/health`', 'Inline `POST /api/nope`',
    '```md', '### `GET /api/example`', '```',
    '~~~md', '### `GET /api/example-two`', '~~~',
    '### `GET /api/health`', '### `DELETE /api/users/:id`',
  ].join('\n');
  assert.deepEqual(documentedEndpoints(markdown), ['GET /api/health', 'GET /api/health', 'DELETE /api/users/:id']);
});

test('reports missing, stale, duplicate documented, and duplicate registered endpoints', () => {
  assert.deepEqual(compareEndpoints(['GET /api/ok'], ['GET /api/ok']), []);
  assert.deepEqual(compareEndpoints(['GET /api/new', 'GET /api/new'], ['GET /api/old', 'GET /api/old']), [
    'Missing documentation: GET /api/new',
    'Stale documentation: GET /api/old',
    'Duplicate registration: GET /api/new',
    'Duplicate documentation: GET /api/old',
  ]);
});

test('ignores commented registrations and rejects dynamic paths instead of silently losing coverage', () => {
  const source = `super('/example', deps);
    // this.get('/old', handler);
    /* this.post('/removed', schema, handler); */
    this.get('/', handler);`;
  assert.deepEqual(extractEndpoints(source, '/api'), ['GET /api/example']);
  assert.throws(() => extractEndpoints(`super(prefix, deps); this.get('/', handler);`, '/api'), /literal/);
  assert.throws(() => extractEndpoints(`super('/example', deps); this.get(dynamic, handler);`, '/api'), /literal/);
  assert.throws(() => extractEndpoints(`super('/example', deps);`, '/api'), /No endpoint/);
});

test('CLI resolves its own repository root and exits nonzero for coverage errors', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'check-http-'));
  const write = (path, content) => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), {recursive: true});
    writeFileSync(target, content);
  };
  try {
    write('packages/stack/src/Server.ts', fixture.server);
    write('packages/stack/src/routes/index.ts', fixture.framework);
    write('packages/create-toto-app/template/server/routes/index.ts', fixture.template);
    for (const [name, source] of Object.entries(fixture.sources)) {
      const [mount, ...registrations] = source.split(';');
      write(`packages/stack/src/routes/api/${name}.ts`,
        `export class ${name} extends BaseRoute { constructor(deps) { ${mount}; } registerRoutes() { ${registrations.join(';')} } }`);
    }
    const page = 'packages/docs/src/content/docs/http/reference.md';
    const headings = collectEndpoints(fixture).map(value => `### \u0060${value}\u0060`).join('\n');
    write(page, headings);
    write('packages/docs/scripts/check-http.mjs', '');
    copyFileSync(new URL('./check-http.mjs', import.meta.url), join(root, 'packages/docs/scripts/check-http.mjs'));
    for (const [cwd, script] of [[root, 'packages/docs/scripts/check-http.mjs'], [join(root, 'packages/docs'), 'scripts/check-http.mjs']]) {
      const result = spawnSync(process.execPath, [script], {cwd, encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /3 registered endpoints documented across 1 pages/);
    }
    write(page, `${headings}\n### \u0060GET /api/status\u0060\n### \u0060GET /api/stale\u0060`.replace('### `GET /api/health`', ''));
    const result = spawnSync(process.execPath, ['packages/docs/scripts/check-http.mjs'], {cwd: root, encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing documentation: GET \/api\/health/);
    assert.match(result.stderr, /Stale documentation: GET \/api\/stale/);
    assert.match(result.stderr, /Duplicate documentation: GET \/api\/status/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('combines the server prefix, BaseRoute path, and helper path', () => {
  assert.deepEqual(extractEndpoints(`
    export class ExampleRoute extends BaseRoute {
      constructor(deps) { super('/auth/login', deps, {auth: false}); }
      registerRoutes() {
        this.post('/', schema, handler);
        this.post('/verify', schema, handler);
        this.get("/state", handler);
        this.delete('/:id', schema, handler);
        this.put('/settings', schema, handler);
        this.patch('/settings', schema, handler);
      }
    }
  `, '/api'), [
    'POST /api/auth/login', 'POST /api/auth/login/verify',
    'GET /api/auth/login/state', 'DELETE /api/auth/login/:id',
    'PUT /api/auth/login/settings', 'PATCH /api/auth/login/settings',
  ]);
});
