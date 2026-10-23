// CI coverage for scripts/check-merge-safety.mjs `pre` — the FU-91 expected-checks gate.
//
// Green must mean "every EXPECTED check present + concluded success", never
// "no failure seen". The script runs against the mock `gh` (a CLEAN/MERGEABLE
// PR via MOCK_TRAIN_PRE_JSON + a rollup via MOCK_ROLLUP_JSON), so the gate's
// check-membership logic is exercised deterministically.
//
// Run: node --test scripts/__tests__/check-merge-safety.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'check-merge-safety.mjs');
const MOCK_BIN = join(here, 'fixtures', 'ralph-mock-bin');
chmodSync(join(MOCK_BIN, 'gh'), 0o755);

// A CLEAN, MERGEABLE PR so `pre` reaches the FU-91 expected-checks logic.
const CLEAN_PR = JSON.stringify({
  number: 7, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  headRefOid: 'a'.repeat(40), isDraft: false, title: 'a slice',
});
const rollup = (checks) => JSON.stringify({ statusCheckRollup: checks });
const run = (env) => {
  const dir = mkdtempSync(join(tmpdir(), 'cms-'));
  try {
    const r = spawnSync('node', [SCRIPT, '7', 'pre'], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${MOCK_BIN}:${process.env.PATH}`, MOCK_TRAIN_PRE_JSON: CLEAN_PR, MOCK_PR_EXISTS: '7', ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const CR = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, conclusion });

// The live failure: a required workflow that NEVER registered looks identical to pass.
test('FU-91: an expected check that never registered → not-green (named), exit 1', () => {
  const { status, out } = run({
    RALPH_EXPECTED_CHECKS: 'acceptance,SonarCloud',
    MOCK_ROLLUP_JSON: rollup([CR('SonarCloud', 'COMPLETED', 'SUCCESS')]),  // acceptance ABSENT
  });
  assert.equal(status, 1, out);
  assert.match(out, /never registered: acceptance/);
});

test('FU-91: every expected check present + success → mergeable (exit 0)', () => {
  const { status, out } = run({
    RALPH_EXPECTED_CHECKS: 'acceptance,SonarCloud',
    MOCK_ROLLUP_JSON: rollup([CR('acceptance', 'COMPLETED', 'SUCCESS'), CR('SonarCloud', 'COMPLETED', 'SUCCESS')]),
  });
  assert.equal(status, 0, out);
  assert.match(out, /Expected checks present \+ passing: acceptance, SonarCloud/);
});

test('FU-91: a still-pending check is not-green even with no failure (exit 1)', () => {
  const { status, out } = run({
    RALPH_EXPECTED_CHECKS: 'acceptance',
    MOCK_ROLLUP_JSON: rollup([CR('acceptance', 'IN_PROGRESS', null)]),
  });
  assert.equal(status, 1, out);
  assert.match(out, /pending/i);
});

test('FU-91: an expected check that FAILED → not-green (exit 1)', () => {
  const { status, out } = run({
    RALPH_EXPECTED_CHECKS: 'acceptance',
    MOCK_ROLLUP_JSON: rollup([CR('acceptance', 'COMPLETED', 'FAILURE')]),
  });
  assert.equal(status, 1, out);
  assert.match(out, /did not succeed: acceptance=FAILURE/);
});

test('FU-91: no manifest → loud advisory, but mergeable is not blocked (back-compat)', () => {
  const { status, out } = run({ MOCK_ROLLUP_JSON: rollup([CR('SonarCloud', 'COMPLETED', 'SUCCESS')]) });
  assert.equal(status, 0, out);
  assert.match(out, /No expected-checks manifest/);
});

test('FU-91: legacy StatusContext (state PENDING) is read as pending', () => {
  const { status, out } = run({
    RALPH_EXPECTED_CHECKS: 'ci/acceptance',
    MOCK_ROLLUP_JSON: rollup([{ __typename: 'StatusContext', context: 'ci/acceptance', state: 'PENDING' }]),
  });
  assert.equal(status, 1, out);
  assert.match(out, /pending/i);
});

// FOLLOW-UP 136: `gh pr view --json` checks field names client-side, and
// `baseRefOid` only exists from gh 2.63.0. On an older gh every `pre` failed
// with "Could not read PR" (the mock gh rejects the field the same way).
test('FU-136: pre works on a gh without baseRefOid and names the base read through GraphQL', () => {
  const { status, out } = run({
    MOCK_BASE_OID: 'b'.repeat(40),
    MOCK_ROLLUP_JSON: rollup([CR('SonarCloud', 'COMPLETED', 'SUCCESS')]),
  });
  assert.equal(status, 0, out);
  assert.match(out, /state=CLEAN, base=bbbbbbb, head=aaaaaaa/);
});

test('FU-136: the base oid is display-only — an unreadable one prints unknown and does not block', () => {
  const { status, out } = run({ MOCK_ROLLUP_JSON: rollup([CR('SonarCloud', 'COMPLETED', 'SUCCESS')]) });
  assert.equal(status, 0, out);
  assert.match(out, /base=unknown, head=aaaaaaa/);
});

test('FU-136: a failed gh pr view says what gh said', () => {
  const { status, out } = run({ MOCK_PR_VIEW_FAIL: 'HTTP 401: Bad credentials' });
  assert.equal(status, 1, out);
  assert.match(out, /Could not read PR #7 via 'gh pr view': HTTP 401: Bad credentials/);
});
