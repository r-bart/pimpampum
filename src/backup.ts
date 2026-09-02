import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { AppError } from './errors.js';
import type {
  ContextDocument,
  ContextManifest,
  Project,
  ProjectManifest,
  ProjectState,
  Spec,
  SpecManifest,
  SpecState,
  Task,
  TaskManifest,
  Workspace,
} from './types.js';

interface PortableExportSource {
  listWorkspaces(): Workspace[];
  listProjectManifests(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): ProjectManifest[];
  getProject(projectId: string): Project;
  listSpecManifests(input: {
    projectId: string;
    state: SpecState | null;
    limit: number;
    offset: number;
  }): SpecManifest[];
  getSpec(specId: string): Spec;
  listTaskManifests(input: { specId: string; limit: number; offset: number }): TaskManifest[];
  getTask(taskId: string): Task;
  listContextManifests(input: {
    ownerType: 'workspace' | 'project';
    ownerId: string;
    limit: number;
    offset: number;
  }): ContextManifest[];
  readContext(ownerType: 'workspace' | 'project', ownerId: string, name: string): ContextDocument;
}

const PROJECT_EXPORT_PAGE_SIZE = 10;
const COLLECTION_EXPORT_PAGE_SIZE = 100;

/**
 * Resolves the file a Context document is exported to and refuses any name
 * that could leave the `context` directory. HTTP, MCP, and the sync contract
 * all enforce slugs, but the export must hold on its own when a caller bypasses
 * them: the shared folder is a trust boundary.
 */
function contextDocumentPath(contextPath: string, name: string): string {
  const reject = (): never => {
    throw new AppError('bad_request', 'Context name is not a safe export file name', 400, false, {
      name,
    });
  };
  if (
    name.length === 0 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name.includes('\0')
  ) {
    reject();
  }
  const documentPath = resolve(contextPath, `${name}.md`);
  /* v8 ignore next -- a name without separators, `..` or NUL always resolves inside; belt and braces. */
  if (relative(resolve(contextPath), documentPath) !== `${name}.md`) reject();
  return documentPath;
}

function writeContextExport(
  source: PortableExportSource,
  ownerType: 'workspace' | 'project',
  ownerId: string,
  ownerPath: string,
): void {
  const contextPath = join(ownerPath, 'context');
  mkdirSync(contextPath, { recursive: true });
  const metadataPath = join(ownerPath, 'context.json');
  writeFileSync(metadataPath, '[\n');
  let offset = 0;
  let firstDocument = true;
  while (true) {
    const manifests = source.listContextManifests({
      ownerType,
      ownerId,
      limit: COLLECTION_EXPORT_PAGE_SIZE,
      offset,
    });
    for (const manifest of manifests) {
      const document = source.readContext(ownerType, ownerId, manifest.name);
      const documentPath = contextDocumentPath(contextPath, document.name);
      const { body: _body, ...metadata } = document;
      appendFileSync(
        metadataPath,
        `${firstDocument ? '' : ',\n'}${JSON.stringify(metadata, null, 2)}`,
      );
      firstDocument = false;
      writeFileSync(documentPath, document.body);
    }
    if (manifests.length < COLLECTION_EXPORT_PAGE_SIZE) break;
    offset += manifests.length;
  }
  appendFileSync(metadataPath, '\n]\n');
}

function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

/**
 * Where the verified copy is staged before it is copied to the destination. The database's own
 * directory is the 0700 data directory, so the staging file is never visible in a shared
 * temporary directory; an in-memory database has no directory and gets a fresh 0700 one instead.
 */
function stagingDirectory(database: Database.Database): string {
  return database.memory
    ? mkdtempSync(join(tmpdir(), 'pimpampum-backup-'))
    : dirname(resolve(database.name));
}

/**
 * Creates the staging file exclusively with mode 0600 before SQLite writes a byte into it, so
 * there is no window in which the copy exists with a default mode. `database.backup` accepts an
 * existing empty file as its destination.
 */
function createPrivateStagingFile(directory: string, label: string): string {
  const path = join(directory, `.pimpampum-${label}-${randomUUID()}.sqlite.partial`);
  closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  return path;
}

async function stageVerifiedCopy(
  database: Database.Database,
  label: string,
): Promise<{ path: string; cleanup(): void }> {
  const directory = stagingDirectory(database);
  const path = createPrivateStagingFile(directory, label);
  // The source runs in WAL mode and the copy inherits it, so the read-only integrity check leaves
  // `-wal`/`-shm` sidecars next to the staging file; remove them with it.
  const cleanup = (): void => {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(`${path}${suffix}`, { force: true });
    if (database.memory) rmSync(directory, { recursive: true, force: true });
  };
  try {
    await database.backup(path);
    const snapshot = new Database(path, { readonly: true, fileMustExist: true });
    let integrity: unknown;
    try {
      integrity = snapshot.pragma('integrity_check', { simple: true });
    } finally {
      snapshot.close();
    }
    if (integrity !== 'ok') {
      throw new AppError('internal_error', 'SQLite backup failed its integrity check', 500);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return { path, cleanup };
}

export async function backupDatabase(
  database: Database.Database,
  destinationDirectory: string,
): Promise<string> {
  mkdirSync(destinationDirectory, { recursive: true });
  const finalPath = join(
    destinationDirectory,
    `pimpampum-${safeTimestamp()}-${randomUUID()}.sqlite`,
  );
  const destinationPartialPath = `${finalPath}.partial`;
  const staged = await stageVerifiedCopy(database, 'backup');

  try {
    copyFileSync(staged.path, destinationPartialPath, constants.COPYFILE_EXCL);
    chmodSync(destinationPartialPath, 0o600);
    renameSync(destinationPartialPath, finalPath);
    return finalPath;
  } finally {
    staged.cleanup();
    rmSync(destinationPartialPath, { force: true });
  }
}

export async function backupLatestDatabase(
  database: Database.Database,
  destinationDirectory: string,
): Promise<string> {
  const finalPath = join(destinationDirectory, 'pimpampum-latest.sqlite');
  const destinationPartialPath = join(
    destinationDirectory,
    `.pimpampum-latest-${randomUUID()}.partial`,
  );
  const staged = await stageVerifiedCopy(database, 'latest');

  try {
    copyFileSync(staged.path, destinationPartialPath, constants.COPYFILE_EXCL);
    chmodSync(destinationPartialPath, 0o600);
    renameSync(destinationPartialPath, finalPath);
    return finalPath;
  } finally {
    staged.cleanup();
    rmSync(destinationPartialPath, { force: true });
  }
}

export function exportPortable(source: PortableExportSource, destinationDirectory: string): string {
  mkdirSync(destinationDirectory, { recursive: true });
  const exportedAt = new Date().toISOString();
  const exportPath = join(
    destinationDirectory,
    `pimpampum-export-${safeTimestamp()}-${randomUUID()}`,
  );
  const partialPath = `${exportPath}.partial`;
  mkdirSync(partialPath, { mode: 0o700 });

  try {
    const workspaces = source.listWorkspaces();
    writeFileSync(
      join(partialPath, 'manifest.json'),
      `${JSON.stringify({ schemaVersion: 2, exportedAt }, null, 2)}\n`,
    );
    writeFileSync(join(partialPath, 'workspaces.json'), `${JSON.stringify(workspaces, null, 2)}\n`);

    for (const workspace of workspaces) {
      const workspacePath = join(partialPath, 'workspaces', workspace.id);
      mkdirSync(workspacePath, { recursive: true });
      writeContextExport(source, 'workspace', workspace.id, workspacePath);
      const projectsPath = join(workspacePath, 'projects');
      mkdirSync(projectsPath, { recursive: true });
      let offset = 0;
      while (true) {
        const projectManifests = source.listProjectManifests({
          workspaceId: workspace.id,
          state: null,
          limit: PROJECT_EXPORT_PAGE_SIZE,
          offset,
        });
        for (const projectManifest of projectManifests) {
          const project = source.getProject(projectManifest.id);
          const projectPath = join(projectsPath, project.slug);
          mkdirSync(projectPath, { recursive: true });
          writeFileSync(join(projectPath, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
          writeContextExport(source, 'project', project.id, projectPath);

          const specsPath = join(projectPath, 'specs');
          mkdirSync(specsPath, { recursive: true });
          let specOffset = 0;
          while (true) {
            const specManifests = source.listSpecManifests({
              projectId: project.id,
              state: null,
              limit: COLLECTION_EXPORT_PAGE_SIZE,
              offset: specOffset,
            });
            for (const specManifest of specManifests) {
              const spec = source.getSpec(specManifest.id);
              const specPath = join(specsPath, spec.slug);
              mkdirSync(specPath, { recursive: true });
              const { body: _body, claim: _claim, ...specMetadata } = spec;
              writeFileSync(
                join(specPath, 'spec.json'),
                `${JSON.stringify(specMetadata, null, 2)}\n`,
              );
              writeFileSync(join(specPath, 'spec.md'), spec.body);

              const tasksPath = join(specPath, 'tasks.json');
              writeFileSync(tasksPath, '[\n');
              let taskOffset = 0;
              let firstTask = true;
              while (true) {
                const taskManifests = source.listTaskManifests({
                  specId: spec.id,
                  limit: COLLECTION_EXPORT_PAGE_SIZE,
                  offset: taskOffset,
                });
                for (const taskManifest of taskManifests) {
                  const { claim: _taskClaim, ...task } = source.getTask(taskManifest.id);
                  appendFileSync(
                    tasksPath,
                    `${firstTask ? '' : ',\n'}${JSON.stringify(task, null, 2)}`,
                  );
                  firstTask = false;
                }
                if (taskManifests.length < COLLECTION_EXPORT_PAGE_SIZE) break;
                taskOffset += taskManifests.length;
              }
              appendFileSync(tasksPath, '\n]\n');
            }
            if (specManifests.length < COLLECTION_EXPORT_PAGE_SIZE) break;
            specOffset += specManifests.length;
          }
        }
        if (projectManifests.length < PROJECT_EXPORT_PAGE_SIZE) break;
        offset += projectManifests.length;
      }
    }
    renameSync(partialPath, exportPath);
    return exportPath;
  } finally {
    rmSync(partialPath, { recursive: true, force: true });
  }
}
