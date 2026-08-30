/**
 * The CLI describes itself from one table.
 *
 * `pimpampum commands` serializes this catalog as JSON, and `pimpampum help` renders the same
 * catalog as text. Neither is hand-written, so the human banner and the machine catalog cannot
 * drift apart, and a new verb is discoverable the moment it is declared here.
 *
 * Annotations mirror the MCP tool annotations returned by `pimpampum tools`, so an agent can apply
 * one rule to both surfaces: `readOnlyHint` means the command changes nothing, `destructiveHint`
 * means it can remove or overwrite state, `idempotentHint` means repeating it is safe, and
 * `requiresDaemon` means the command fails with `unavailable` when the daemon is not answering.
 */

export interface CliArgument {
  name: string;
  required: boolean;
  description: string;
  values?: readonly string[];
}

export interface CliOption {
  flag: string;
  /** `null` marks a boolean flag that takes no value. */
  value: string | null;
  description: string;
  required?: boolean;
  repeatable?: boolean;
  default?: string;
  deprecated?: string;
}

export interface CliAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  requiresDaemon: boolean;
}

export interface CliCommand {
  /** The literal token sequence that invokes the command, space separated. */
  name: string;
  summary: string;
  arguments: readonly CliArgument[];
  options: readonly CliOption[];
  annotations: CliAnnotations;
}

const read: CliAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  requiresDaemon: true,
};
const localRead: CliAnnotations = { ...read, requiresDaemon: false };
const write: CliAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  requiresDaemon: true,
};
const idempotentWrite: CliAnnotations = { ...write, idempotentHint: true };
const destructiveWrite: CliAnnotations = { ...write, destructiveHint: true, idempotentHint: true };

const actorOption: CliOption = {
  flag: '--actor',
  value: 'id',
  description: 'Identity recorded in the activity log for this change.',
  default: 'cli',
};

const artifactOptions: readonly CliOption[] = [
  {
    flag: '--artifact',
    value: 'uri',
    description: 'Artifact URI or absolute path to record. Repeat for several, up to 20.',
    repeatable: true,
  },
  {
    flag: '--artifacts',
    value: 'json',
    description:
      'Full artifact array as JSON, for labelled references: [{"label":"PR","uri":"https://..."}]. Cannot be combined with --artifact.',
  },
];

/** Accepted and ignored. Output has always been JSON; installed desktop helpers still pass it. */
const legacyJsonOption: CliOption = {
  flag: '--json',
  value: null,
  description: 'No effect. Output is always JSON.',
  deprecated: 'Output is always JSON; the flag is accepted only for compatibility.',
};

const targetArguments: readonly CliArgument[] = [
  {
    name: 'target-type',
    required: true,
    description: 'Kind of executable resource that may own a Claim.',
    values: ['spec', 'task'],
  },
  { name: 'target-id', required: true, description: 'UUID of the Spec or Task.' },
  {
    name: 'agent-id',
    required: true,
    description: 'Stable identifier of the agent holding the Claim.',
  },
];

const leaseOption: CliOption = {
  flag: '--lease-seconds',
  value: 'n',
  description: 'Lease duration in seconds.',
  default: '1800',
};

export const CLI_COMMANDS: readonly CliCommand[] = [
  {
    name: 'help',
    summary: 'Print this command catalog as text. Use `commands` for the JSON form.',
    arguments: [],
    options: [],
    annotations: localRead,
  },
  {
    name: 'version',
    summary: 'Report the Pimpampum version. Also available as --version and -v.',
    arguments: [],
    options: [],
    annotations: localRead,
  },
  {
    name: 'commands',
    summary:
      'Return this command catalog as JSON, with arguments, options, and effect annotations. Works offline.',
    arguments: [],
    options: [],
    annotations: localRead,
  },
  {
    name: 'config',
    summary:
      'Report the effective data directory, base URL, MCP URL, and stdio command. Works offline and never prints the token.',
    arguments: [],
    options: [],
    annotations: localRead,
  },
  {
    name: 'serve',
    summary: 'Run the daemon in the foreground until SIGINT or SIGTERM.',
    arguments: [],
    options: [],
    annotations: { ...write, requiresDaemon: false, idempotentHint: false },
  },
  {
    name: 'mcp',
    summary:
      'Run the MCP stdio bridge on this process. stdout carries the protocol, so this command writes no envelope. Registry clients reach it as `npx pimpampum mcp`.',
    arguments: [],
    options: [],
    annotations: { ...write, idempotentHint: false },
  },
  {
    name: 'install',
    summary:
      'Install the per-user background service and start it at login. No prompts, no root, safe to run unattended.',
    arguments: [],
    options: [
      {
        flag: '--service-only',
        value: null,
        description: 'Install the daemon without the platform desktop application.',
      },
    ],
    annotations: { ...idempotentWrite, requiresDaemon: false },
  },
  {
    name: 'status',
    summary: 'Report whether the background service is installed and running.',
    arguments: [],
    options: [],
    annotations: { ...read, requiresDaemon: false },
  },
  {
    name: 'update:check',
    summary: 'Check npm for a newer Pimpampum release without changing the installation.',
    arguments: [],
    options: [],
    annotations: localRead,
  },
  {
    name: 'update',
    summary: 'Install the latest npm release and reconcile the service and desktop integration.',
    arguments: [],
    options: [],
    annotations: { ...idempotentWrite, requiresDaemon: false },
  },
  {
    name: 'uninstall',
    summary: 'Remove the background service. Preserves the database and the data directory.',
    arguments: [],
    options: [],
    annotations: { ...destructiveWrite, requiresDaemon: false },
  },
  {
    name: 'health',
    summary: 'Confirm the daemon answers and report its version.',
    arguments: [],
    options: [],
    annotations: read,
  },
  {
    name: 'overview',
    summary: 'Return the bounded portfolio overview that the desktop surfaces render.',
    arguments: [],
    options: [],
    annotations: read,
  },
  {
    name: 'tools',
    summary:
      'Return the live MCP tool catalog with full JSON Schemas. This is the authoritative contract.',
    arguments: [],
    options: [],
    annotations: read,
  },
  {
    name: 'call',
    summary:
      'Invoke one MCP tool by name. This is the complete domain surface and the preferred route for an agent.',
    arguments: [
      {
        name: 'tool-name',
        required: true,
        description: 'Tool name exactly as reported by `pimpampum tools`.',
      },
    ],
    options: [
      { flag: '--input', value: 'json', description: 'Inline JSON object.' },
      { flag: '--stdin', value: null, description: 'Read the JSON object from standard input.' },
      {
        flag: '--input-file',
        value: 'path',
        description: 'Read the JSON object from a UTF-8 file.',
      },
    ],
    annotations: { ...write, idempotentHint: false },
  },
  {
    name: 'workspace:list',
    summary: 'List every registered workspace. Equivalent to `call workspace_list`.',
    arguments: [],
    options: [],
    annotations: read,
  },
  {
    name: 'workspace:add',
    summary: 'Register a workspace anchored to one filesystem root.',
    arguments: [
      { name: 'workspace-id', required: true, description: 'Lowercase kebab-case identifier.' },
      { name: 'name', required: true, description: 'Human-readable workspace name.' },
      { name: 'root-path', required: true, description: 'Absolute path to the workspace root.' },
    ],
    options: [actorOption],
    annotations: idempotentWrite,
  },
  {
    name: 'work:list',
    summary: 'List work that can be started right now. Equivalent to `call work_list`.',
    arguments: [
      { name: 'workspace-id', required: false, description: 'Workspace filter.' },
      { name: 'project-id', required: false, description: 'Project filter.' },
      { name: 'spec-id', required: false, description: 'Spec filter.' },
    ],
    options: [
      { flag: '--limit', value: 'n', description: 'Maximum items to return.', default: '50' },
    ],
    annotations: read,
  },
  {
    name: 'work:start',
    summary: 'Take an expiring lease on exactly one Spec or leaf Task.',
    arguments: targetArguments,
    options: [leaseOption],
    annotations: write,
  },
  {
    name: 'work:renew',
    summary: 'Extend the lease on a Claim this agent already holds.',
    arguments: targetArguments,
    options: [leaseOption],
    annotations: idempotentWrite,
  },
  {
    name: 'work:release',
    summary: 'Give a Claim back untouched.',
    arguments: [
      ...targetArguments,
      { name: 'note', required: false, description: 'Handover note recorded on release.' },
    ],
    options: [{ flag: '--note', value: 'text', description: 'Handover note recorded on release.' }],
    annotations: idempotentWrite,
  },
  {
    name: 'work:complete',
    summary: 'Record a summary and artifact references, then release the Claim.',
    arguments: [
      ...targetArguments,
      { name: 'revision', required: true, description: 'Revision read before the change.' },
      { name: 'summary', required: true, description: 'What was done.' },
    ],
    options: artifactOptions,
    annotations: write,
  },
  {
    name: 'project:create',
    summary: 'Create a Project inside a Workspace.',
    arguments: [
      { name: 'workspace-id', required: true, description: 'Owning workspace identifier.' },
      { name: 'slug', required: true, description: 'Lowercase kebab-case project slug.' },
      { name: 'title', required: true, description: 'Human-readable project title.' },
    ],
    options: [actorOption],
    annotations: write,
  },
  {
    name: 'project:get',
    summary: 'Read one Project manifest.',
    arguments: [{ name: 'project-id', required: true, description: 'Project UUID.' }],
    options: [],
    annotations: read,
  },
  {
    name: 'project:draft',
    summary: 'Move a Project back to draft.',
    arguments: [
      { name: 'project-id', required: true, description: 'Project UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
    ],
    options: [actorOption],
    annotations: write,
  },
  {
    name: 'project:open',
    summary: 'Open a Project for work.',
    arguments: [
      { name: 'project-id', required: true, description: 'Project UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
    ],
    options: [actorOption],
    annotations: write,
  },
  {
    name: 'project:pause',
    summary: 'Pause a Project.',
    arguments: [
      { name: 'project-id', required: true, description: 'Project UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
    ],
    options: [actorOption],
    annotations: write,
  },
  {
    name: 'project:complete',
    summary: 'Complete a Project through the domain completion operation.',
    arguments: [
      { name: 'project-id', required: true, description: 'Project UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
      { name: 'summary', required: true, description: 'Completion summary.' },
    ],
    options: [...artifactOptions, actorOption],
    annotations: write,
  },
  {
    name: 'project:cancel',
    summary: 'Cancel a Project.',
    arguments: [
      { name: 'project-id', required: true, description: 'Project UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
      { name: 'reason', required: true, description: 'Why the Project was cancelled.' },
    ],
    options: [actorOption],
    annotations: destructiveWrite,
  },
  {
    name: 'spec:create',
    summary: 'Create a Spec inside a Project.',
    arguments: [
      { name: 'project-id', required: true, description: 'Owning project UUID.' },
      { name: 'slug', required: true, description: 'Lowercase kebab-case spec slug.' },
      { name: 'title', required: true, description: 'Human-readable spec title.' },
      { name: 'body-file', required: false, description: 'Path to the Markdown body.' },
    ],
    options: [
      { flag: '--body-file', value: 'path', description: 'Path to the Markdown body.' },
      actorOption,
    ],
    annotations: write,
  },
  {
    name: 'spec:get',
    summary: 'Read one Spec manifest.',
    arguments: [{ name: 'spec-id', required: true, description: 'Spec UUID.' }],
    options: [],
    annotations: read,
  },
  {
    name: 'spec:draft',
    summary: 'Move a Spec back to draft.',
    arguments: [
      { name: 'spec-id', required: true, description: 'Spec UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
    ],
    options: [actorOption],
    annotations: write,
  },
  {
    name: 'spec:ready',
    summary: 'Mark a Spec ready, which makes it claimable when it has no open Tasks.',
    arguments: [
      { name: 'spec-id', required: true, description: 'Spec UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
    ],
    options: [actorOption],
    annotations: write,
  },
  {
    name: 'spec:cancel',
    summary: 'Cancel a Spec.',
    arguments: [
      { name: 'spec-id', required: true, description: 'Spec UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
      { name: 'reason', required: true, description: 'Why the Spec was cancelled.' },
    ],
    options: [actorOption],
    annotations: destructiveWrite,
  },
  {
    name: 'task:create',
    summary: 'Create a Task under a Spec, or a Subtask under a Task.',
    arguments: [
      { name: 'spec-id', required: true, description: 'Owning spec UUID.' },
      { name: 'title', required: true, description: 'Human-readable task title.' },
      {
        name: 'parent-id',
        required: false,
        description: 'Parent Task UUID. One level of subtasks, and no more.',
      },
    ],
    options: [
      { flag: '--parent', value: 'id', description: 'Parent Task UUID.' },
      { flag: '--body-file', value: 'path', description: 'Path to the Markdown body.' },
      actorOption,
    ],
    annotations: write,
  },
  {
    name: 'task:get',
    summary: 'Read one Task manifest.',
    arguments: [{ name: 'task-id', required: true, description: 'Task UUID.' }],
    options: [],
    annotations: read,
  },
  {
    name: 'task:cancel',
    summary: 'Cancel a Task.',
    arguments: [
      { name: 'task-id', required: true, description: 'Task UUID.' },
      { name: 'revision', required: true, description: 'Revision read before the change.' },
      { name: 'reason', required: true, description: 'Why the Task was cancelled.' },
    ],
    options: [actorOption],
    annotations: destructiveWrite,
  },
  {
    name: 'backup',
    summary: 'Write one verified SQLite backup into a directory.',
    arguments: [{ name: 'directory', required: true, description: 'Destination directory.' }],
    options: [],
    annotations: idempotentWrite,
  },
  {
    name: 'backup status',
    summary: 'Report automatic backup configuration and health.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: read,
  },
  {
    name: 'backup configure',
    summary: 'Enable automatic backups into an absolute directory.',
    arguments: [
      { name: 'directory', required: true, description: 'Absolute destination directory.' },
    ],
    options: [legacyJsonOption],
    annotations: idempotentWrite,
  },
  {
    name: 'backup retry',
    summary: 'Retry the automatic backup after a failure.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: idempotentWrite,
  },
  {
    name: 'backup disable',
    summary: 'Disable automatic backups.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: idempotentWrite,
  },
  {
    name: 'sync status',
    summary: 'Report shared-folder health, pending snapshots, and conflicts.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: read,
  },
  {
    name: 'sync configure',
    summary: 'Point synchronization at a folder your provider already syncs.',
    arguments: [
      {
        name: 'directory',
        required: true,
        description: 'Absolute parent directory. Never the live database directory.',
      },
    ],
    options: [
      {
        flag: '--device',
        value: 'id',
        description: 'Stable identifier for this machine.',
        required: true,
      },
      legacyJsonOption,
    ],
    annotations: idempotentWrite,
  },
  {
    name: 'sync now',
    summary: 'Reconcile with the shared folder immediately.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: idempotentWrite,
  },
  {
    name: 'sync pause',
    summary: 'Pause synchronization without forgetting the configuration.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: idempotentWrite,
  },
  {
    name: 'sync resume',
    summary: 'Resume paused synchronization.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: idempotentWrite,
  },
  {
    name: 'sync conflicts',
    summary: 'List preserved synchronization conflicts. Never resolve one autonomously.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: read,
  },
  {
    name: 'sync resolve',
    summary: 'Resolve one conflict by choosing a side. Ask the operator first.',
    arguments: [
      { name: 'conflict-id', required: true, description: 'Conflict identifier.' },
      {
        name: 'choice',
        required: true,
        description: 'Which candidate wins.',
        values: ['local', 'remote'],
      },
    ],
    options: [legacyJsonOption],
    annotations: destructiveWrite,
  },
  {
    name: 'sync forget',
    summary: 'Forget the synchronization configuration. Leaves snapshots on disk.',
    arguments: [],
    options: [legacyJsonOption],
    annotations: destructiveWrite,
  },
  {
    name: 'export',
    summary:
      'Write a portable export. A synchronous maintenance operation: never start it while claims are active.',
    arguments: [{ name: 'directory', required: true, description: 'Destination directory.' }],
    options: [],
    annotations: idempotentWrite,
  },
];

function renderArgument(argument: CliArgument): string {
  const body = argument.values ? argument.values.join('|') : argument.name;
  return argument.required ? `<${body}>` : `[${body}]`;
}

function renderOption(option: CliOption): string {
  const body = option.value === null ? option.flag : `${option.flag} <${option.value}>`;
  if (option.required === true) return body;
  return option.repeatable === true ? `[${body}]...` : `[${body}]`;
}

/** The single invocation line for one command, derived so it cannot drift from the catalog. */
export function renderUsageLine(command: CliCommand): string {
  return [
    'pimpampum',
    command.name,
    ...command.arguments.map(renderArgument),
    ...command.options.map(renderOption),
  ].join(' ');
}

/** The catalog `pimpampum commands` returns, with the usage line resolved for each entry. */
export function describeCommands(version: string): {
  version: string;
  commands: Array<CliCommand & { usage: string }>;
} {
  return {
    version,
    commands: CLI_COMMANDS.map((command) => ({ ...command, usage: renderUsageLine(command) })),
  };
}

/** The text banner `pimpampum help` prints, rendered from the same catalog. */
export function renderUsage(version: string): string {
  const lines = CLI_COMMANDS.map((command) => `  ${renderUsageLine(command)}`);
  return `Pimpampum ${version}

Every command writes one {"data": ...} envelope to stdout and exits 0, or one
{"error": ...} envelope to stderr and exits non-zero. The only
exceptions are \`help\`, which prints this text, and \`mcp\`, whose stdout carries
the MCP protocol. Run \`pimpampum commands\` for the same catalog as JSON, and
\`pimpampum tools\` for the domain tool schemas.

Use \`--\` to end option parsing when a value itself begins with two dashes.

Usage:
${lines.join('\n')}
`;
}
