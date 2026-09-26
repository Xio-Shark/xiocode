#!/usr/bin/env node
/**
 * Automated Crash Drill for xiocode with @xioflow/kernel@0.2.0.
 *
 * Verifies three crash scenarios:
 *  1. Crash before spawn (intent_registered) -> cleaned_unspawned
 *  2. Crash while running (active with orphan descendants) -> group reaped + marked_dead
 *  3. Crash while stopping (stopping state) -> honest recovery
 *  4. Indeterminate operation -> preserved lease -> xio kernel adjudicate -> lease cleanly released
 *
 * Followed by database invariant verification using check-invariants.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert';

import {
  ExecutionDomain,
  NodePlatformDriver,
  ProcessSupervisor,
  RecoveryEngine,
} from '@xioflow/kernel';

import { KernelProcessRunner } from '../src/runtime/process/kernel-adapter.ts';

const rootDir = path.resolve(import.meta.dirname, '..');
const kernelDir = path.resolve(rootDir, '../projects/xioflow');
const invariantsChecker = path.join(kernelDir, 'scripts/check-invariants.mjs');

const drillWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiocode-drill-'));
const domainDir = path.join(drillWorkspace, 'kernel-domain');

console.log(`\x1b[34m[Drill] Initializing crash drill in: ${drillWorkspace}\x1b[0m`);

try {
  // ==========================================
  // Scenario 1: Crash before spawn (intent_registered)
  // ==========================================
  console.log('\n\x1b[36m--- Scenario 1: Crash before spawn (intent_registered) ---\x1b[0m');
  {
    const domain = ExecutionDomain.acquire(domainDir, 'drill-1');
    const store = domain.getStore();
    const taskId = 'task-drill-1';
    const runId = 'run-drill-1';
    const opId = 'op-drill-prespawn-1';

    store.saveTask({ id: taskId, domainId: domain.domainId, name: 'Task 1', createdAt: new Date().toISOString() });
    store.saveRun({ id: runId, taskId, domainId: domain.domainId, owner: 'drill-1', status: 'running', startedAt: new Date().toISOString() });
    domain.registerOperationIntent({
      id: opId,
      runId,
      kind: 'process',
      name: 'process:prespawn',
      inputFingerprint: 'fp-prespawn',
      requiredResources: ['res:prespawn-lock'],
      status: 'intent_registered',
    });
    // Crash before spawn: domain abruptly closed without terminal result or process identity
    domain.close();

    // Recovery by new runner
    const runner = new KernelProcessRunner({
      sessionId: 'drill-1',
      domainPath: domainDir,
    });
    runner.ensureDomain();
    const report = await new RecoveryEngine(runner.ensureDomain(), new NodePlatformDriver()).recover();
    const recOp = report.recoveredOperations.find((o) => o.opId === opId);
    assert(recOp, 'Presumed op was not in recovery report');
    assert.strictEqual(recOp.action, 'cleaned_unspawned');
    assert.strictEqual(recOp.resourcesReleased, true);
    assert.strictEqual(runner.ensureDomain().isResourceLocked('res:prespawn-lock'), false);
    runner.close();
    console.log('  \x1b[32m✔ Scenario 1 PASS: Unspawned intent cleaned, lease released\x1b[0m');
  }

  // ==========================================
  // Scenario 2: Crash while running (active with orphan descendants)
  // ==========================================
  console.log('\n\x1b[36m--- Scenario 2: Crash while running (active, SIGKILLed leader) ---\x1b[0m');
  {
    const marker = path.join(drillWorkspace, 'leader.pid');
    const domain = ExecutionDomain.acquire(domainDir, 'drill-2');
    const store = domain.getStore();
    const taskId = 'task-drill-2';
    const runId = 'run-drill-2';
    const opId = 'op-drill-active-orphan-2';

    store.saveTask({ id: taskId, domainId: domain.domainId, name: 'Task 2', createdAt: new Date().toISOString() });
    store.saveRun({ id: runId, taskId, domainId: domain.domainId, owner: 'drill-2', status: 'running', startedAt: new Date().toISOString() });

    // Spawn real child with descendants: shell spawns background sleep and writes its PID
    const child = spawn(
      '/bin/sh',
      ['-c', `echo "$$" > "${marker}" && sleep 30 & wait`],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    const leaderPid = child.pid;
    assert(leaderPid, 'Failed to spawn child');
    child.unref();

    let attempts = 0;
    while (!fs.existsSync(marker) && attempts++ < 50) {
      spawnSync('sleep', ['0.05']);
    }
    assert(fs.existsSync(marker), 'Marker file not written');

    domain.registerOperationIntent({
      id: opId,
      runId,
      kind: 'process',
      name: 'process:active',
      inputFingerprint: 'fp-active',
      requiredResources: ['res:active-group-lock'],
      status: 'active',
      processIdentity: {
        pid: leaderPid,
        pgid: leaderPid,
        spawnTime: new Date().toISOString(),
        commandFingerprint: '/bin/sh',
      },
    });

    // Crash: kill the leader abruptly and close domain
    domain.close();
    try {
      process.kill(leaderPid, 'SIGKILL');
    } catch {}

    // Verify orphan group is still alive before recovery
    let groupAlive = false;
    try {
      process.kill(-leaderPid, 0);
      groupAlive = true;
    } catch {}
    assert(groupAlive, 'Orphan process group died prematurely');

    // Run recovery
    const recoveryDriver = new NodePlatformDriver();
    const recoveryDomain = ExecutionDomain.acquire(domainDir, 'drill-2');
    const report = await new RecoveryEngine(recoveryDomain, recoveryDriver).recover();
    const recOp = report.recoveredOperations.find((o) => o.opId === opId);
    assert(recOp, 'Active op not recovered');
    assert(['marked_dead', 'stopped_alive_process'].includes(recOp.action), `Unexpected action: ${recOp.action}`);
    assert.strictEqual(recOp.resourcesReleased, true);
    assert.strictEqual(recoveryDomain.isResourceLocked('res:active-group-lock'), false);

    // Verify descendant group was reaped
    spawnSync('sleep', ['0.1']);
    let groupAliveAfter = false;
    try {
      process.kill(-leaderPid, 0);
      groupAliveAfter = true;
    } catch {}
    assert.strictEqual(groupAliveAfter, false, 'Orphan process group was not reaped!');
    recoveryDomain.close();
    console.log('  \x1b[32m✔ Scenario 2 PASS: Zombie leader + orphan group reaped and lease released\x1b[0m');
  }

  // ==========================================
  // Scenario 3: Crash while stopping
  // ==========================================
  console.log('\n\x1b[36m--- Scenario 3: Crash while stopping ---\x1b[0m');
  {
    const domain = ExecutionDomain.acquire(domainDir, 'drill-3');
    const store = domain.getStore();
    const taskId = 'task-drill-3';
    const runId = 'run-drill-3';
    const opId = 'op-drill-stopping-3';

    store.saveTask({ id: taskId, domainId: domain.domainId, name: 'Task 3', createdAt: new Date().toISOString() });
    store.saveRun({ id: runId, taskId, domainId: domain.domainId, owner: 'drill-3', status: 'running', startedAt: new Date().toISOString() });

    domain.registerOperationIntent({
      id: opId,
      runId,
      kind: 'process',
      name: 'process:stopping',
      inputFingerprint: 'fp-stopping',
      requiredResources: ['res:stopping-lock'],
      status: 'stopping',
      processIdentity: {
        pid: 2_147_483_600, // Non-existent PID
        pgid: 2_147_483_600,
        spawnTime: new Date().toISOString(),
      },
    });
    domain.close();

    const recoveryDomain = ExecutionDomain.acquire(domainDir, 'drill-3');
    const report = await new RecoveryEngine(recoveryDomain, new NodePlatformDriver()).recover();
    const recOp = report.recoveredOperations.find((o) => o.opId === opId);
    assert(recOp, 'Stopping op not recovered');
    assert.strictEqual(recOp.action, 'marked_dead');
    assert.strictEqual(recOp.resourcesReleased, true);
    assert.strictEqual(recoveryDomain.isResourceLocked('res:stopping-lock'), false);
    recoveryDomain.close();
    console.log('  \x1b[32m✔ Scenario 3 PASS: Stopping crash recovered cleanly\x1b[0m');
  }

  // ==========================================
  // Scenario 4: Indeterminate isolation & CLI Adjudication
  // ==========================================
  console.log('\n\x1b[36m--- Scenario 4: Indeterminate state and CLI Adjudication ---\x1b[0m');
  {
    const domain = ExecutionDomain.acquire(domainDir, 'drill-4');
    const store = domain.getStore();
    const taskId = 'task-drill-4';
    const runId = 'run-drill-4';
    const opId = 'op-drill-indeterminate-4';

    store.saveTask({ id: taskId, domainId: domain.domainId, name: 'Task 4', createdAt: new Date().toISOString() });
    store.saveRun({ id: runId, taskId, domainId: domain.domainId, owner: 'drill-4', status: 'running', startedAt: new Date().toISOString() });

    domain.registerOperationIntent({
      id: opId,
      runId,
      kind: 'process',
      name: 'process:indet',
      inputFingerprint: 'fp-indet',
      requiredResources: ['res:isolated-lock-4'],
      status: 'active',
      processIdentity: {
        pid: 1,
        bootId: 'stale-boot-session-id',
        spawnTime: new Date().toISOString(),
      },
    });
    domain.close();

    // Recovery isolates it
    const recoveryDomain = ExecutionDomain.acquire(domainDir, 'drill-4');
    const report = await new RecoveryEngine(recoveryDomain, new NodePlatformDriver()).recover();
    const recOp = report.recoveredOperations.find((o) => o.opId === opId);
    assert(recOp, 'Indeterminate op not recovered');
    assert.strictEqual(recOp.action, 'isolated_indeterminate');
    assert.strictEqual(recOp.resourcesReleased, false);
    assert.strictEqual(recoveryDomain.isResourceLocked('res:isolated-lock-4'), true);
    recoveryDomain.close();
    console.log('  \x1b[33m• Operation isolated as indeterminate; lock retained\x1b[0m');

    // Run CLI adjudication
    const cliOutput = execFileSync(
      'node',
      [
        '--experimental-strip-types',
        path.join(rootDir, 'src/cli/entry.ts'),
        'kernel',
        'adjudicate',
        opId,
        '--domain',
        domainDir,
        '--verdict',
        'confirmed_stopped',
        '--note',
        'Drill adjudication verification',
      ],
      { encoding: 'utf8' }
    );
    console.log(cliOutput.trim());

    // Verify lock released after adjudication
    const postAdjDomain = ExecutionDomain.acquire(domainDir, 'drill-4');
    assert.strictEqual(postAdjDomain.isResourceLocked('res:isolated-lock-4'), false);
    postAdjDomain.close();
    console.log('  \x1b[32m✔ Scenario 4 PASS: CLI adjudicate resolved indeterminate op and released lock\x1b[0m');
  }

  // ==========================================
  // Invariant Checker Check
  // ==========================================
  console.log('\n\x1b[36m--- Running Database Invariant Checker ---\x1b[0m');
  const dbFile = path.join(domainDir, 'domain.db');
  const invOutput = execFileSync('node', [invariantsChecker, dbFile], { encoding: 'utf8' });
  console.log(invOutput.trim());
  console.log('\n\x1b[32m🎉 ALL CRASH DRILL SCENARIOS & INVARIANTS PASSED!\x1b[0m\n');
} finally {
  try {
    fs.rmSync(drillWorkspace, { recursive: true, force: true });
  } catch {}
}
