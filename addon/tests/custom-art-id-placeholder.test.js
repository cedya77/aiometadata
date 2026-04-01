const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractFunction(source, functionName) {
  const startToken = `function ${functionName}`;
  const startIndex = source.indexOf(startToken);
  assert.notEqual(startIndex, -1, `Expected ${functionName} to exist`);

  const bodyStart = source.indexOf('{', startIndex);
  assert.notEqual(bodyStart, -1, `Expected ${functionName} body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return source.slice(startIndex, index + 1);
    }
  }

  throw new Error(`Could not extract ${functionName}`);
}

const parsePropsSource = fs.readFileSync(
  path.join(__dirname, '..', 'utils', 'parseProps.js'),
  'utf8',
);
const indexSource = fs.readFileSync(
  path.join(__dirname, '..', 'index.js'),
  'utf8',
);

const resolvePattern = vm.runInNewContext(
  `(${extractFunction(parsePropsSource, 'resolvePattern')})`,
);
const extractIdsFromMeta = vm.runInNewContext(
  `(${extractFunction(indexSource, 'extractIdsFromMeta')})`,
);

test('extractIdsFromMeta preserves the raw meta id', () => {
  const ids = extractIdsFromMeta({ id: 'mal:16498' });

  assert.equal(ids.id, 'mal:16498');
  assert.equal(ids.malId, '16498');
});

test('resolvePattern supports the raw id placeholder', () => {
  const url = resolvePattern(
    'https://example.com/poster/{id}.jpg?lang={language_short}',
    { id: 'mal:16498', malId: '16498' },
    'series',
    { language: 'en-US', apiKeys: {} },
  );

  assert.equal(url, 'https://example.com/poster/mal:16498.jpg?lang=en');
});
