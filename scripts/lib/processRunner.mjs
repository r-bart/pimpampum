// Bounded child-process execution for the live runners: every command runs in its own process
// group with a timeout and an output cap, and the whole group is reaped when the leader exits or
// misbehaves. Exit codes are normalised the way the transcript records them:
//   124 timeout, 130 interrupted, 125 any other enforced outcome, otherwise the child's own code.

import { spawn } from 'node:child_process';
import { pollUntil } from './waitFor.mjs';

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;

function isGone(error) {
  return error?.code === 'ESRCH' || error?.code === 'EPERM';
}

/** Sends `signal` to the process group led by `pid`; a group that is already gone is not an error. */
export function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/** Resolves true once no process in the group led by `pid` remains, false after the attempts. */
export async function waitForProcessGroupExit(pid, options = {}) {
  const { attempts = 80, intervalMs = 25 } = options;
  const outcome = await pollUntil(
    () => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        if (isGone(error)) return true;
        throw error;
      }
    },
    { attempts, intervalMs },
  );
  return outcome.satisfied;
}

function appendOutput(stderr, line) {
  return `${stderr}${stderr ? '\n' : ''}${line}`;
}

function normalisedExitCode(outcome, exitCode) {
  if (outcome === 'timeout') return 124;
  if (outcome === 'interrupted') return 130;
  if (outcome) return 125;
  return exitCode ?? 1;
}

/**
 * Creates an `execute({ executable, arguments, timeoutMs, allowBackground })` function plus
 * `abortActiveCommands()`, which terminates every running command and waits for them to settle.
 * `allowBackground` accepts a leader that exits while its group lives on (for example xdg-open);
 * otherwise a surviving group is an enforced failure.
 */
export function createProcessRunner(options) {
  const {
    cwd,
    environment,
    defaultTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  } = options;
  const activeCommands = new Set();

  const execute = ({
    executable,
    arguments: arguments_,
    timeoutMs = defaultTimeoutMs,
    allowBackground = false,
  }) =>
    new Promise((resolveResult) => {
      let stdout = '';
      let stderr = '';
      let outcome = null;
      let completed = false;
      let resolveCompletion;
      const completion = new Promise((resolveDone) => {
        resolveCompletion = resolveDone;
      });
      const child = spawn(executable, arguments_, {
        cwd,
        env: environment,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let forceTimer = null;
      const terminate = (reason) => {
        if (!outcome) outcome = reason;
        signalProcessGroup(child.pid, 'SIGTERM');
        if (!forceTimer) {
          forceTimer = setTimeout(() => signalProcessGroup(child.pid, 'SIGKILL'), 250);
          forceTimer.unref?.();
        }
      };
      const active = { terminate, completion };
      activeCommands.add(active);
      const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
      timeout.unref?.();
      const append = (stream, chunk) => {
        const combined = stream + chunk.toString('utf8');
        if (Buffer.byteLength(combined) > outputLimitBytes) {
          terminate('output-limit');
          return combined.slice(0, outputLimitBytes);
        }
        return combined;
      };
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
      const reapSurvivors = async () => {
        const leader = Number.isInteger(child.pid) && child.pid > 0;
        if (!outcome && !allowBackground && leader) {
          try {
            process.kill(-child.pid, 0);
            outcome = 'unexpected-background';
            signalProcessGroup(child.pid, 'SIGTERM');
            if (!(await waitForProcessGroupExit(child.pid))) {
              signalProcessGroup(child.pid, 'SIGKILL');
              if (!(await waitForProcessGroupExit(child.pid))) {
                outcome = 'process-group-survived';
                stderr = appendOutput(stderr, 'command process group did not exit');
              }
            }
          } catch (groupError) {
            if (!isGone(groupError)) throw groupError;
          }
        } else if (outcome && leader) {
          if (forceTimer) clearTimeout(forceTimer);
          signalProcessGroup(child.pid, 'SIGKILL');
          if (!(await waitForProcessGroupExit(child.pid))) {
            outcome = 'process-group-survived';
            stderr = appendOutput(stderr, 'timed-out process group did not exit');
          }
        } else if (forceTimer) clearTimeout(forceTimer);
      };
      const finish = async (exitCode, error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        await reapSurvivors();
        activeCommands.delete(active);
        if (error) stderr = appendOutput(stderr, error.message);
        resolveResult({ exitCode: normalisedExitCode(outcome, exitCode), stdout, stderr });
        resolveCompletion();
      };
      child.once('error', (error) => void finish(1, error));
      child.once('close', (code) => void finish(code, null));
    });

  const abortActiveCommands = async () => {
    const active = [...activeCommands];
    for (const command of active) command.terminate('interrupted');
    await Promise.all(active.map((command) => command.completion));
  };

  return { execute, abortActiveCommands };
}
