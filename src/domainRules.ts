import type { ProjectState, SpecState, TargetType, TaskState } from './types.js';

export interface DomainRuleDecision {
  allowed: boolean;
  reason: string | null;
}

export interface ProjectTransitionFacts {
  specCount: number;
  nonTerminalSpecCount: number;
  activeDescendantClaimCount: number;
}

export interface SpecTransitionFacts {
  body: string;
  nonTerminalTaskCount: number;
  activeClaimCount: number;
  activeDescendantClaimCount: number;
}

export interface TaskTransitionFacts {
  nonTerminalSubtaskCount: number;
}

export type ClaimEligibilityFacts =
  | {
      targetType: 'spec';
      projectState: ProjectState;
      specState: SpecState;
      openTaskCount: number;
    }
  | {
      targetType: 'task';
      projectState: ProjectState;
      specState: SpecState;
      taskState: TaskState;
      openSubtaskCount: number;
    };

const ALLOWED: DomainRuleDecision = { allowed: true, reason: null };

function blocked(reason: string): DomainRuleDecision {
  return { allowed: false, reason };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled domain value: ${String(value)}`);
}

export function isTerminalProjectState(state: ProjectState): boolean {
  switch (state) {
    case 'draft':
    case 'open':
    case 'paused':
      return false;
    case 'done':
    case 'cancelled':
      return true;
    default:
      return assertNever(state);
  }
}

export function isTerminalSpecState(state: SpecState): boolean {
  switch (state) {
    case 'draft':
    case 'ready':
      return false;
    case 'done':
    case 'cancelled':
      return true;
    default:
      return assertNever(state);
  }
}

export function isTerminalTaskState(state: TaskState): boolean {
  switch (state) {
    case 'open':
      return false;
    case 'done':
    case 'cancelled':
      return true;
    default:
      return assertNever(state);
  }
}

export function evaluateProjectTransition(
  from: ProjectState,
  to: ProjectState,
  facts: ProjectTransitionFacts,
): DomainRuleDecision {
  if (from === to) return ALLOWED;
  if (isTerminalProjectState(from)) return blocked(`Project state ${from} is terminal.`);

  const allowedTargets: Record<ProjectState, readonly ProjectState[]> = {
    draft: ['open', 'cancelled'],
    open: ['draft', 'paused', 'done', 'cancelled'],
    paused: ['open', 'cancelled'],
    done: [],
    cancelled: [],
  };
  const transitionAllowed = allowedTargets[from].includes(to);

  if (!transitionAllowed) return blocked(`Project cannot transition from ${from} to ${to}.`);
  if (to === 'open' && facts.specCount === 0) {
    return blocked('Project must contain at least one Spec before it can become open.');
  }
  if (to === 'done' && (facts.specCount === 0 || facts.nonTerminalSpecCount > 0)) {
    return blocked('Project can become done only after every Spec is terminal.');
  }
  if (to !== 'cancelled' && facts.activeDescendantClaimCount > 0) {
    return blocked('Release active descendant Claims before changing the Project lifecycle.');
  }
  return ALLOWED;
}

export function evaluateSpecTransition(
  from: SpecState,
  to: SpecState,
  facts: SpecTransitionFacts,
): DomainRuleDecision {
  if (from === to) return ALLOWED;
  if (isTerminalSpecState(from)) return blocked(`Spec state ${from} is terminal.`);

  const allowedTargets: Record<SpecState, readonly SpecState[]> = {
    draft: ['ready', 'cancelled'],
    ready: ['draft', 'done', 'cancelled'],
    done: [],
    cancelled: [],
  };
  const transitionAllowed = allowedTargets[from].includes(to);

  if (!transitionAllowed) return blocked(`Spec cannot transition from ${from} to ${to}.`);
  if (to === 'ready' && facts.body.trim().length === 0) {
    return blocked('Spec Markdown must be non-empty before it can become ready.');
  }
  if (to === 'done' && facts.nonTerminalTaskCount > 0) {
    return blocked('Spec can become done only after every Task is terminal.');
  }
  if (
    to !== 'cancelled' &&
    to !== 'done' &&
    (facts.activeClaimCount > 0 || facts.activeDescendantClaimCount > 0)
  ) {
    return blocked('Release active Claims before changing the Spec lifecycle.');
  }
  return ALLOWED;
}

export function evaluateTaskTransition(
  from: TaskState,
  to: TaskState,
  facts: TaskTransitionFacts,
): DomainRuleDecision {
  if (from === to) return ALLOWED;
  if (isTerminalTaskState(from)) return blocked(`Task state ${from} is terminal.`);

  if (to === 'done') {
    return facts.nonTerminalSubtaskCount === 0
      ? ALLOWED
      : blocked('Task can become done only after every Subtask is terminal.');
  }
  if (to === 'cancelled') return ALLOWED;
  return assertNever(to as never);
}

export function evaluateClaimEligibility(facts: ClaimEligibilityFacts): DomainRuleDecision {
  if (facts.projectState !== 'open') {
    return blocked('Claimable work must belong to an open Project.');
  }
  if (facts.specState !== 'ready') {
    return blocked('Claimable work must belong to a ready Spec.');
  }

  switch (facts.targetType) {
    case 'spec':
      return facts.openTaskCount === 0
        ? ALLOWED
        : blocked('A Spec is claimable only when it has no open Tasks.');
    case 'task':
      if (facts.taskState !== 'open') return blocked('Only open Tasks are claimable.');
      return facts.openSubtaskCount === 0
        ? ALLOWED
        : blocked('A Task is claimable only when it has no open Subtasks.');
    default:
      return assertNever(facts);
  }
}

export function isClaimableTargetType(targetType: string): targetType is TargetType {
  return targetType === 'spec' || targetType === 'task';
}
