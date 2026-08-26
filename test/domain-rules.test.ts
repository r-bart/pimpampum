import { describe, expect, it } from 'vitest';
import {
  evaluateClaimEligibility,
  evaluateProjectTransition,
  evaluateSpecTransition,
  evaluateTaskTransition,
  isClaimableTargetType,
  isTerminalProjectState,
  isTerminalSpecState,
  isTerminalTaskState,
} from '../src/domainRules.js';
import {
  contextOwnerTypeSchema,
  createProjectSchema,
  createSpecSchema,
  projectStateSchema,
  specStateSchema,
  targetTypeSchema,
  taskStateSchema,
} from '../src/schemas.js';
import type { ProjectState, SpecState, TaskState } from '../src/types.js';

const projectFacts = {
  specCount: 1,
  nonTerminalSpecCount: 0,
  activeDescendantClaimCount: 0,
};
const specFacts = {
  body: '# Deliverable',
  nonTerminalTaskCount: 0,
  activeClaimCount: 0,
  activeDescendantClaimCount: 0,
};

describe('v2 domain schemas', () => {
  it('exposes only the canonical lifecycle, target, and Context owner vocabularies', () => {
    expect(projectStateSchema.options).toEqual(['draft', 'open', 'paused', 'done', 'cancelled']);
    expect(specStateSchema.options).toEqual(['draft', 'ready', 'done', 'cancelled']);
    expect(taskStateSchema.options).toEqual(['open', 'done', 'cancelled']);
    expect(targetTypeSchema.options).toEqual(['spec', 'task']);
    expect(contextOwnerTypeSchema.options).toEqual(['workspace', 'project']);
  });

  it('creates Projects without embedded Markdown and Specs with Markdown', () => {
    expect(
      createProjectSchema.parse({ workspaceId: 'workspace', slug: 'outcome', title: 'Outcome' }),
    ).toEqual({
      workspaceId: 'workspace',
      slug: 'outcome',
      title: 'Outcome',
      actor: null,
    });
    expect(createSpecSchema.parse({ slug: 'feature', title: 'Feature' })).toEqual({
      slug: 'feature',
      title: 'Feature',
      body: '',
      actor: null,
    });
  });
});

describe('v2 lifecycle rules', () => {
  it('classifies terminal states exhaustively', () => {
    const activeProjects: ProjectState[] = ['draft', 'open', 'paused'];
    const terminalProjects: ProjectState[] = ['done', 'cancelled'];
    const activeSpecs: SpecState[] = ['draft', 'ready'];
    const terminalSpecs: SpecState[] = ['done', 'cancelled'];
    const taskStates: TaskState[] = ['open', 'done', 'cancelled'];

    expect(activeProjects.map(isTerminalProjectState)).toEqual([false, false, false]);
    expect(terminalProjects.map(isTerminalProjectState)).toEqual([true, true]);
    expect(activeSpecs.map(isTerminalSpecState)).toEqual([false, false]);
    expect(terminalSpecs.map(isTerminalSpecState)).toEqual([true, true]);
    expect(taskStates.map(isTerminalTaskState)).toEqual([false, true, true]);
  });

  it('fails closed for impossible runtime lifecycle values', () => {
    expect(() => isTerminalProjectState('invalid' as ProjectState)).toThrow(
      'Unhandled domain value: invalid',
    );
    expect(() => isTerminalSpecState('invalid' as SpecState)).toThrow(
      'Unhandled domain value: invalid',
    );
    expect(() => isTerminalTaskState('invalid' as TaskState)).toThrow(
      'Unhandled domain value: invalid',
    );
  });

  it('enforces Project transitions, readiness, completion, claims, and terminal immutability', () => {
    expect(evaluateProjectTransition('open', 'open', projectFacts)).toEqual({
      allowed: true,
      reason: null,
    });
    expect(evaluateProjectTransition('draft', 'open', projectFacts).allowed).toBe(true);
    expect(evaluateProjectTransition('open', 'draft', projectFacts).allowed).toBe(true);
    expect(evaluateProjectTransition('open', 'paused', projectFacts).allowed).toBe(true);
    expect(evaluateProjectTransition('paused', 'open', projectFacts).allowed).toBe(true);
    expect(
      evaluateProjectTransition('draft', 'open', { ...projectFacts, specCount: 0 }).reason,
    ).toMatch(/at least one Spec/);
    expect(
      evaluateProjectTransition('open', 'done', { ...projectFacts, specCount: 0 }).reason,
    ).toMatch(/every Spec is terminal/);
    expect(
      evaluateProjectTransition('open', 'done', { ...projectFacts, nonTerminalSpecCount: 1 })
        .reason,
    ).toMatch(/every Spec is terminal/);
    expect(
      evaluateProjectTransition('open', 'paused', {
        ...projectFacts,
        activeDescendantClaimCount: 1,
      }).reason,
    ).toMatch(/active descendant Claims/);
    expect(evaluateProjectTransition('done', 'open', projectFacts).reason).toMatch(/terminal/);
    expect(evaluateProjectTransition('draft', 'paused', projectFacts).reason).toMatch(
      /cannot transition/,
    );
    expect(
      evaluateProjectTransition('open', 'cancelled', {
        ...projectFacts,
        activeDescendantClaimCount: 1,
      }).allowed,
    ).toBe(true);
  });

  it('enforces Spec transitions, meaningful Markdown, claims, and child completion', () => {
    expect(evaluateSpecTransition('ready', 'ready', specFacts)).toEqual({
      allowed: true,
      reason: null,
    });
    expect(evaluateSpecTransition('draft', 'ready', specFacts).allowed).toBe(true);
    expect(evaluateSpecTransition('ready', 'draft', specFacts).allowed).toBe(true);
    expect(evaluateSpecTransition('draft', 'ready', { ...specFacts, body: '  ' }).reason).toMatch(
      /non-empty/,
    );
    expect(
      evaluateSpecTransition('ready', 'done', { ...specFacts, nonTerminalTaskCount: 1 }).reason,
    ).toMatch(/every Task is terminal/);
    expect(
      evaluateSpecTransition('ready', 'draft', { ...specFacts, activeClaimCount: 1 }).reason,
    ).toMatch(/active Claims/);
    expect(
      evaluateSpecTransition('ready', 'draft', {
        ...specFacts,
        activeDescendantClaimCount: 1,
      }).reason,
    ).toMatch(/active Claims/);
    expect(evaluateSpecTransition('done', 'ready', specFacts).reason).toMatch(/terminal/);
    expect(evaluateSpecTransition('draft', 'done', specFacts).reason).toMatch(/cannot transition/);
    expect(
      evaluateSpecTransition('ready', 'cancelled', { ...specFacts, activeDescendantClaimCount: 1 })
        .allowed,
    ).toBe(true);
  });

  it('allows only open Tasks with terminal Subtasks to finish', () => {
    expect(evaluateTaskTransition('open', 'open', { nonTerminalSubtaskCount: 0 })).toEqual({
      allowed: true,
      reason: null,
    });
    expect(evaluateTaskTransition('open', 'done', { nonTerminalSubtaskCount: 0 }).allowed).toBe(
      true,
    );
    expect(evaluateTaskTransition('open', 'done', { nonTerminalSubtaskCount: 1 }).reason).toMatch(
      /every Subtask is terminal/,
    );
    expect(
      evaluateTaskTransition('open', 'cancelled', { nonTerminalSubtaskCount: 1 }).allowed,
    ).toBe(true);
    expect(evaluateTaskTransition('done', 'open', { nonTerminalSubtaskCount: 0 }).reason).toMatch(
      /terminal/,
    );
    expect(() =>
      evaluateTaskTransition('open', 'invalid' as TaskState, { nonTerminalSubtaskCount: 0 }),
    ).toThrow('Unhandled domain value: invalid');
  });
});

describe('v2 claim eligibility', () => {
  it('admits ready Specs only after their open Tasks are terminal', () => {
    expect(
      evaluateClaimEligibility({
        targetType: 'spec',
        projectState: 'open',
        specState: 'ready',
        openTaskCount: 0,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateClaimEligibility({
        targetType: 'spec',
        projectState: 'open',
        specState: 'ready',
        openTaskCount: 1,
      }).reason,
    ).toMatch(/no open Tasks/);
  });

  it('admits only open leaf Tasks beneath ready Specs in open Projects', () => {
    const task = {
      targetType: 'task' as const,
      projectState: 'open' as const,
      specState: 'ready' as const,
      taskState: 'open' as const,
      openSubtaskCount: 0,
    };
    expect(evaluateClaimEligibility(task).allowed).toBe(true);
    expect(evaluateClaimEligibility({ ...task, projectState: 'paused' }).reason).toMatch(
      /open Project/,
    );
    expect(evaluateClaimEligibility({ ...task, specState: 'draft' }).reason).toMatch(/ready Spec/);
    expect(evaluateClaimEligibility({ ...task, taskState: 'done' }).reason).toMatch(/open Tasks/);
    expect(evaluateClaimEligibility({ ...task, openSubtaskCount: 1 }).reason).toMatch(
      /no open Subtasks/,
    );
    expect(isClaimableTargetType('spec')).toBe(true);
    expect(isClaimableTargetType('task')).toBe(true);
    expect(isClaimableTargetType('project')).toBe(false);
  });

  it('fails closed for an impossible runtime Claim target', () => {
    expect(() =>
      evaluateClaimEligibility({
        targetType: 'project',
        projectState: 'open',
        specState: 'ready',
      } as never),
    ).toThrow('Unhandled domain value');
  });
});
