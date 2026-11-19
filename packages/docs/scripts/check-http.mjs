#!/usr/bin/env node

import {readFileSync, readdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

function registeredClasses(source, name) {
  const match = new RegExp(`\\bconst\\s+${name}\\s*(?::\\s*RouteClass\\[\\])?\\s*=\\s*\\[([^\\]]*)\\]`).exec(uncomment(source));
  if (!match || !/^\s*(?:[A-Za-z_$][\w$]*\s*,\s*)*(?:[A-Za-z_$][\w$]*\s*)?$/.test(match[1])) {
    throw new Error(`Expected a literal class array: ${name}`);
  }
  return match[1].split(',').map(value => value.trim()).filter(Boolean);
}

function serverPrefix(source, factory) {
  const match = new RegExp(`\\bapp\\.use\\(\\s*(['"])(/[^'"\\\\]*)\\1\\s*,\\s*${factory}\\(`).exec(uncomment(source));
  if (!match) throw new Error(`Expected a literal server mount for ${factory}`);
  return match[2];
}

export function collectEndpoints({server, framework, template, sources}) {
  const groups = [
    [serverPrefix(server, 'registerSessionlessApiRoutes'), registeredClasses(framework, 'SESSIONLESS_ROUTES')],
    [serverPrefix(server, 'registerApiRoutes'), [...registeredClasses(framework, 'BUILTIN_ROUTES'), ...registeredClasses(template, 'routes')]],
  ];
  return groups.flatMap(([prefix, classes]) => classes.flatMap(name => {
    if (!Object.hasOwn(sources, name)) throw new Error(`Missing route source: ${name}`);
    return extractEndpoints(sources[name], prefix);
  }));
}

export function documentedEndpoints(markdown) {
  const endpoints = [];
  let fence;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^### `(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/api(?:\/[^`\s]*)?)`\s*$/.exec(line);
    if (match) endpoints.push(`${match[1]} ${match[2]}`);
  }
  return endpoints;
}

export function compareEndpoints(actual, documented) {
  const actualSet = new Set(actual);
  const documentedSet = new Set(documented);
  const duplicates = values => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
  return [
    ...[...actualSet].filter(value => !documentedSet.has(value)).sort().map(value => `Missing documentation: ${value}`),
    ...[...documentedSet].filter(value => !actualSet.has(value)).sort().map(value => `Stale documentation: ${value}`),
    ...duplicates(actual).map(value => `Duplicate registration: ${value}`),
    ...duplicates(documented).map(value => `Duplicate documentation: ${value}`),
  ];
}

function files(directory, extension) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path, extension) : path.endsWith(extension) ? [path] : [];
  }).sort();
}

function main() {
  const root = resolve(import.meta.dirname, '../../..');
  const read = path => readFileSync(join(root, path), 'utf8');
  const sources = {};
  for (const directory of ['packages/stack/src/routes/api', 'packages/create-toto-app/template/server/routes']) {
    for (const path of files(join(root, directory), '.ts')) {
      const source = readFileSync(path, 'utf8');
      const name = /\bexport class (\w+) extends BaseRoute/.exec(uncomment(source))?.[1];
      if (name) {
        if (Object.hasOwn(sources, name)) throw new Error(`Ambiguous route class: ${name}`);
        sources[name] = source;
      }
    }
  }
  const actual = collectEndpoints({
    server: read('packages/stack/src/Server.ts'),
    framework: read('packages/stack/src/routes/index.ts'),
    template: read('packages/create-toto-app/template/server/routes/index.ts'),
    sources,
  });
  const pages = files(resolve(import.meta.dirname, '../src/content/docs/http'), '.md');
  const documented = pages.flatMap(path => documentedEndpoints(readFileSync(path, 'utf8')));
  const errors = compareEndpoints(actual, documented);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`HTTP coverage OK: ${actual.length} registered endpoints documented across ${pages.length} pages.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Deliberately scoped to the literal BaseRoute registrations used in this repo.
// Preserve quoted strings while dropping comments (not a general TypeScript parser).
function uncomment(source) {
  return source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_match, string) => string ?? ' ');
}

export function extractEndpoints(source, prefix) {
  source = uncomment(source);
  const mount = /\bsuper\(\s*(['"])(\/[^'"\\]*)\1\s*,/.exec(source);
  if (!mount) throw new Error('Expected a literal BaseRoute mount path');
  const calls = [...source.matchAll(/\bthis\.(get|post|put|patch|delete)\s*\(/g)];
  const endpoints = [...source.matchAll(/\bthis\.(get|post|put|patch|delete)\s*\(\s*(['"])(\/[^'"\\]*)\2\s*,/g)];
  if (calls.length !== endpoints.length) throw new Error('Expected literal endpoint paths');
  if (!endpoints.length) throw new Error('No endpoint registrations found');
  return endpoints.map(([, method, , path]) => `${method.toUpperCase()} ${[prefix, mount[2], path].join('/').replace(/\/{2,}/g, '/').replace(/\/$/, '')}`);
}
