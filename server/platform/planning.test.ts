import { describe, expect, it } from 'vitest';
import { coordinatorPlanSchema } from '../../shared/platform/contracts';
import { loadRegistry } from './registry';
import { validateCoordinatorPlan } from './runtime';

const task = (key: string, capability: string, dependsOn: string[] = []) => ({
  key, title: `Task ${key}`, objective: `Complete ${key}.`, capability, dependsOn,
});

function expectPlanError(action: () => void, code: string): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code });
}

describe('Coordinator plan validation', () => {
  it('accepts a bounded acyclic plan when each capability has an available specialist', async () => {
    const registry = await loadRegistry(process.cwd());
    const available = new Set(registry.roster.filter((entry) => entry.enabled).map((entry) => entry.id));
    const capability = registry.roster
      .filter((entry) => available.has(entry.id))
      .map((entry) => registry.definitions.get(entry.definition)?.manifest.capabilities[0])
      .find((candidate): candidate is string => !!candidate)!;
    const plan = {
      goal: 'Complete a small implementation.',
      successCriteria: ['The output is verified.'],
      tasks: [task('implement', capability), task('review', capability, ['implement'])],
      responseToUser: '',
    };

    expect(coordinatorPlanSchema.parse(plan)).toEqual(plan);
    expect(() => validateCoordinatorPlan(plan, registry, available)).not.toThrow();
  });

  it('rejects duplicate keys, unknown dependencies, self-dependencies, and cycles', async () => {
    const registry = await loadRegistry(process.cwd());
    const available = new Set(registry.roster.filter((entry) => entry.enabled).map((entry) => entry.id));
    const capability = registry.roster
      .map((entry) => registry.definitions.get(entry.definition)?.manifest.capabilities[0])
      .find((candidate): candidate is string => !!candidate)!;
    const base = { goal: 'Validate a plan.', successCriteria: ['No task starts early.'], responseToUser: '' };

    expectPlanError(() => validateCoordinatorPlan({ ...base, tasks: [task('same', capability), task('same', capability)] }, registry, available), 'PLAN_DUPLICATE_TASK');
    expectPlanError(() => validateCoordinatorPlan({ ...base, tasks: [task('first', capability, ['missing'])] }, registry, available), 'PLAN_INVALID_DEPENDENCY');
    expectPlanError(() => validateCoordinatorPlan({ ...base, tasks: [task('first', capability, ['first'])] }, registry, available), 'PLAN_INVALID_DEPENDENCY');
    expectPlanError(() => validateCoordinatorPlan({ ...base, tasks: [task('first', capability, ['second']), task('second', capability, ['first'])] }, registry, available), 'PLAN_DEPENDENCY_CYCLE');
  });

  it('rejects missing or unavailable capabilities and plans larger than the schema limit', async () => {
    const registry = await loadRegistry(process.cwd());
    const available = new Set(registry.roster.filter((entry) => entry.enabled).map((entry) => entry.id));
    const capability = registry.roster
      .map((entry) => registry.definitions.get(entry.definition)?.manifest.capabilities[0])
      .find((candidate): candidate is string => !!candidate)!;
    const base = { goal: 'Validate a plan.', successCriteria: ['No task starts without a worker.'], responseToUser: '' };

    expectPlanError(() => validateCoordinatorPlan({ ...base, tasks: [task('task', 'capability.no-such-agent')] }, registry, available), 'PLAN_CAPABILITY_UNAVAILABLE');
    expectPlanError(() => validateCoordinatorPlan({ ...base, tasks: [task('task', capability)] }, registry, new Set()), 'PLAN_CAPABILITY_UNAVAILABLE');
    expect(coordinatorPlanSchema.safeParse({ ...base, tasks: Array.from({ length: 13 }, (_, index) => task(`task-${index}`, capability)) }).success).toBe(false);
  });
});
