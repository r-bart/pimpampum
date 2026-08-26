import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AppError } from './errors.js';
import type {
  ContextDocument,
  ContextManifest,
  Project,
  ProjectState,
  Task,
  TaskManifest,
  Workspace,
} from './types.js';

interface PortableExportSource {
  listWorkspaces(): Workspace[];
  listProjects(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): Project[];
  listTaskManifests(input: { projectId: string; limit: number; offset: number }): TaskManifest[];
  getTask(taskId: string): Task;
  listContextManifests(input: {
    projectId: string;
    limit: number;
    offset: number;
  }): ContextManifest[];
  readContext(projectId: string, name: string): ContextDocument;
}

const PROJECT_EXPORT_PAGE_SIZE = 10;
const COLLECTION_EXPORT_PAGE_SIZE = 100;

function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
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
  const localTemporaryPath = join(tmpdir(), `pimpampum-backup-${randomUUID()}.sqlite`);

  try {
    await database.backup(localTemporaryPath);
    chmodSync(localTemporaryPath, 0o600);
    const snapshot = new Database(localTemporaryPath, { readonly: true, fileMustExist: true });
    let integrity: unknown;
    try {
      integrity = snapshot.pragma('integrity_check', { simple: true });
    } finally {
      snapshot.close();
    }
    if (integrity !== 'ok') {
      throw new AppError('internal_error', 'SQLite backup failed its integrity check', 500);
    }

    copyFileSync(localTemporaryPath, destinationPartialPath, constants.COPYFILE_EXCL);
    chmodSync(destinationPartialPath, 0o600);
    renameSync(destinationPartialPath, finalPath);
    return finalPath;
  } finally {
    rmSync(localTemporaryPath, { force: true });
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
  const localTemporaryPath = join(tmpdir(), `pimpampum-latest-${randomUUID()}.sqlite`);

  try {
    await database.backup(localTemporaryPath);
    chmodSync(localTemporaryPath, 0o600);
    const snapshot = new Database(localTemporaryPath, { readonly: true, fileMustExist: true });
    let integrity: unknown;
    try {
      integrity = snapshot.pragma('integrity_check', { simple: true });
    } finally {
      snapshot.close();
    }
    /* v8 ignore start -- SQLite only exposes this branch for a corrupt snapshot. */
    if (integrity !== 'ok') {
      throw new AppError('internal_error', 'SQLite backup failed its integrity check', 500);
    }
    /* v8 ignore stop */

    copyFileSync(localTemporaryPath, destinationPartialPath, constants.COPYFILE_EXCL);
    chmodSync(destinationPartialPath, 0o600);
    renameSync(destinationPartialPath, finalPath);
    return finalPath;
  } finally {
    rmSync(localTemporaryPath, { force: true });
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
      `${JSON.stringify({ schemaVersion: 1, exportedAt }, null, 2)}\n`,
    );
    writeFileSync(join(partialPath, 'workspaces.json'), `${JSON.stringify(workspaces, null, 2)}\n`);

    for (const workspace of workspaces) {
      const workspacePath = join(partialPath, 'projects', workspace.id);
      mkdirSync(workspacePath, { recursive: true });
      let offset = 0;
      while (true) {
        const projects = source.listProjects({
          workspaceId: workspace.id,
          state: null,
          limit: PROJECT_EXPORT_PAGE_SIZE,
          offset,
        });
        for (const project of projects) {
          const projectPath = join(workspacePath, project.slug);
          const contextPath = join(projectPath, 'context');
          mkdirSync(contextPath, { recursive: true });
          const { prd: _prd, claim: _claim, ...metadata } = project;
          writeFileSync(
            join(projectPath, 'project.json'),
            `${JSON.stringify(metadata, null, 2)}\n`,
          );
          writeFileSync(join(projectPath, 'prd.md'), project.prd);
          const tasksPath = join(projectPath, 'tasks.json');
          writeFileSync(tasksPath, '[\n');
          let taskOffset = 0;
          let firstTask = true;
          while (true) {
            const taskManifests = source.listTaskManifests({
              projectId: project.id,
              limit: COLLECTION_EXPORT_PAGE_SIZE,
              offset: taskOffset,
            });
            for (const taskManifest of taskManifests) {
              const { claim: _claim, ...task } = source.getTask(taskManifest.id);
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

          const contextMetadataPath = join(projectPath, 'context.json');
          writeFileSync(contextMetadataPath, '[\n');
          let contextOffset = 0;
          let firstDocument = true;
          while (true) {
            const contextManifests = source.listContextManifests({
              projectId: project.id,
              limit: COLLECTION_EXPORT_PAGE_SIZE,
              offset: contextOffset,
            });
            for (const contextManifest of contextManifests) {
              const document = source.readContext(project.id, contextManifest.name);
              const { body: _body, ...metadata } = document;
              appendFileSync(
                contextMetadataPath,
                `${firstDocument ? '' : ',\n'}${JSON.stringify(metadata, null, 2)}`,
              );
              firstDocument = false;
              writeFileSync(join(contextPath, `${document.name}.md`), document.body);
            }
            if (contextManifests.length < COLLECTION_EXPORT_PAGE_SIZE) break;
            contextOffset += contextManifests.length;
          }
          appendFileSync(contextMetadataPath, '\n]\n');
        }
        if (projects.length < PROJECT_EXPORT_PAGE_SIZE) break;
        offset += projects.length;
      }
    }
    renameSync(partialPath, exportPath);
    return exportPath;
  } finally {
    rmSync(partialPath, { recursive: true, force: true });
  }
}
