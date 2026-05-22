// Shared loader for the test suite.
// package.json has no "type":"module", so the bundled UMD marked.min.js and our
// editor-core.js are CommonJS to Node; we load them via createRequire from ESM tests.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export const marked = require(join(here, '../MarkdownPreview/Resources/marked.min.js'));
export const core = require(join(here, '../MarkdownPreview/Resources/editor-core.js'));

const fixturesDir = join(here, 'fixtures');

/** Load all fixture markdown files as { name, md }. */
export function fixtures() {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f, md: readFileSync(join(fixturesDir, f), 'utf8') }));
}

export function fixture(name) {
  return readFileSync(join(fixturesDir, name), 'utf8');
}
