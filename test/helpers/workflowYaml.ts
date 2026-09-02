import { readFileSync } from 'node:fs';

/**
 * A parser for the YAML subset GitHub Actions workflows in this repository use: block mappings and
 * sequences, plain and quoted scalars, flow sequences of scalars, `{}`, and `|`/`>` block scalars.
 * Anything else (anchors, tags, tabs, multi-document streams) throws, so a workflow written outside
 * this subset fails loudly instead of parsing into a wrong shape. Tests assert on step order and
 * `with:` values from the parsed structure instead of grepping the file text.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping;
export interface YamlMapping {
  [key: string]: YamlValue;
}

export interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  with?: YamlMapping;
  env?: YamlMapping;
}

export interface WorkflowJob {
  needs?: string | string[];
  steps: WorkflowStep[];
  permissions?: YamlMapping;
  strategy?: YamlMapping;
  'runs-on'?: string;
  environment?: string;
}

export interface Workflow {
  name: string;
  on: YamlMapping;
  permissions: YamlMapping | null;
  concurrency: YamlMapping | null;
  jobs: Record<string, WorkflowJob>;
}

const KEY = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/u;

function indentOf(line: string): number {
  if (line.includes('\t')) throw new Error('workflow YAML must not contain tabs');
  return line.length - line.trimStart().length;
}

function significant(line: string): boolean {
  const text = line.trim();
  return text !== '' && !text.startsWith('#');
}

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '#' && (index === 0 || /\s/u.test(text[index - 1]!))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function scalar(raw: string): YamlValue {
  const text = stripComment(raw.trim());
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === '{}') return {};
  if (text === '[]') return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((item) => scalar(item));
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return JSON.parse(text) as string;
  }
  if (/^-?\d+$/u.test(text)) return Number(text);
  if (/^[&*!%@`]/u.test(text)) throw new Error(`unsupported YAML scalar: ${text}`);
  return text;
}

class Parser {
  private index = 0;

  constructor(private readonly lines: string[]) {}

  private skipInsignificant(): void {
    while (this.index < this.lines.length && !significant(this.lines[this.index]!)) {
      this.index += 1;
    }
  }

  private current(): { indent: number; text: string } | null {
    this.skipInsignificant();
    const line = this.lines[this.index];
    if (line === undefined) return null;
    return { indent: indentOf(line), text: line.trim() };
  }

  document(): YamlMapping {
    const first = this.current();
    if (first === null) throw new Error('workflow YAML is empty');
    if (first.text.startsWith('---') || first.text.startsWith('%')) {
      throw new Error('unsupported YAML document marker');
    }
    const value = this.block(first.indent);
    if (this.current() !== null) throw new Error(`unparsed YAML at line ${this.index + 1}`);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('workflow root must be a mapping');
    }
    return value;
  }

  private block(indent: number): YamlValue {
    const line = this.current();
    if (line === null) return null;
    return line.text === '-' || line.text.startsWith('- ')
      ? this.sequence(indent)
      : this.mapping(indent);
  }

  private mapping(indent: number): YamlMapping {
    const result: YamlMapping = {};
    for (;;) {
      const line = this.current();
      if (line === null || line.indent < indent) return result;
      if (line.indent > indent) throw new Error(`bad indentation at line ${this.index + 1}`);
      if (line.text === '-' || line.text.startsWith('- ')) return result;
      const match = KEY.exec(line.text);
      if (!match) throw new Error(`not a mapping entry at line ${this.index + 1}: ${line.text}`);
      const key = match[1]!;
      if (key in result) throw new Error(`duplicate key ${key} at line ${this.index + 1}`);
      this.index += 1;
      result[key] = this.entryValue(indent, match[2]);
    }
  }

  private entryValue(indent: number, rest: string | undefined): YamlValue {
    const text = rest === undefined ? '' : stripComment(rest.trim());
    if (text === '') {
      const next = this.current();
      if (next === null || next.indent < indent) return null;
      if (next.indent === indent) {
        return next.text === '-' || next.text.startsWith('- ') ? this.sequence(indent) : null;
      }
      return this.block(next.indent);
    }
    if (/^[|>]-?$/u.test(text)) return this.blockScalar(indent, text);
    return scalar(text);
  }

  private blockScalar(indent: number, header: string): string {
    const collected: string[] = [];
    let contentIndent: number | null = null;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (line.trim() === '') {
        collected.push('');
        this.index += 1;
        continue;
      }
      const lineIndent = indentOf(line);
      if (lineIndent <= indent) break;
      contentIndent ??= lineIndent;
      if (lineIndent < contentIndent)
        throw new Error(`block scalar dedents at line ${this.index + 1}`);
      collected.push(line.slice(contentIndent));
      this.index += 1;
    }
    while (collected.at(-1) === '') collected.pop();
    const body = header.startsWith('|') ? collected.join('\n') : collected.join(' ').trim();
    return header.endsWith('-') ? body : `${body}\n`;
  }

  private sequence(indent: number): YamlValue[] {
    const result: YamlValue[] = [];
    for (;;) {
      const line = this.current();
      if (line === null || line.indent < indent) return result;
      if (line.indent > indent) throw new Error(`bad indentation at line ${this.index + 1}`);
      if (!(line.text === '-' || line.text.startsWith('- '))) return result;
      const item = line.text.slice(1).trim();
      if (item === '') {
        this.index += 1;
        const next = this.current();
        result.push(next === null || next.indent <= indent ? null : this.block(next.indent));
        continue;
      }
      if (KEY.test(item)) {
        // The first key shares the dash line; re-anchor it at the item indent and read a mapping.
        this.lines[this.index] = `${' '.repeat(indent + 2)}${item}`;
        result.push(this.mapping(indent + 2));
        continue;
      }
      this.index += 1;
      result.push(scalar(item));
    }
  }
}

export function parseWorkflowYaml(source: string): YamlMapping {
  return new Parser(source.split('\n')).document();
}

function mapping(value: YamlValue | undefined, label: string): YamlMapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value;
}

export function readWorkflow(path: string): Workflow {
  const root = parseWorkflowYaml(readFileSync(path, 'utf8'));
  const jobs: Record<string, WorkflowJob> = {};
  for (const [name, job] of Object.entries(mapping(root.jobs, 'jobs'))) {
    const definition = mapping(job, `job ${name}`);
    if (!Array.isArray(definition.steps)) throw new Error(`job ${name} has no steps`);
    jobs[name] = {
      ...(definition as Omit<WorkflowJob, 'steps'>),
      steps: definition.steps.map((step) => mapping(step, `${name} step`) as WorkflowStep),
    };
  }
  return {
    name: String(root.name),
    on: mapping(root.on, 'on'),
    permissions: root.permissions === undefined ? null : mapping(root.permissions, 'permissions'),
    concurrency: root.concurrency === undefined ? null : mapping(root.concurrency, 'concurrency'),
    jobs,
  };
}

/** Index of the step with this `name`, or -1. */
export function stepIndex(steps: WorkflowStep[], name: string): number {
  return steps.findIndex((step) => step.name === name);
}

/** The named steps in the order they appear; throws if one is missing. */
export function stepsNamed(steps: WorkflowStep[], names: string[]): WorkflowStep[] {
  return names.map((name) => {
    const step = steps.find((candidate) => candidate.name === name);
    if (step === undefined) throw new Error(`workflow step not found: ${name}`);
    return step;
  });
}

/** Every `uses:` action reference across all jobs, with the job and step position. */
export function usedActions(workflow: Workflow): Array<{ job: string; step: WorkflowStep }> {
  return Object.entries(workflow.jobs).flatMap(([job, definition]) =>
    definition.steps.filter((step) => step.uses !== undefined).map((step) => ({ job, step })),
  );
}
