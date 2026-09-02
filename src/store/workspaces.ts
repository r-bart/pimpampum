import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { AppError } from '../errors.js';
import type { Workspace } from '../types.js';
import type { StoreContext } from './storeContext.js';
import type { WorkspaceRow } from './rows.js';

/**
 * A NULL `root_path` (a Workspace imported through synchronization without a local root)
 * travels as `''`: `Workspace.rootPath` is a string on every adapter and `workspaceSchema`
 * documents the empty string as the unresolved marker.
 */
export function mapWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function realDirectory(rootPath: string): string {
  if (!isAbsolute(rootPath))
    throw new AppError('bad_request', 'Workspace root must be an absolute path', 400);
  let resolved: string;
  try {
    resolved = realpathSync(rootPath);
  } catch {
    throw new AppError('bad_request', 'Workspace root does not exist', 400);
  }
  if (!statSync(resolved).isDirectory())
    throw new AppError('bad_request', 'Workspace root must be a directory', 400);
  return resolved;
}

function hasUnresolvedRoot(ctx: StoreContext, id: string): boolean {
  const existing = ctx.database.prepare('SELECT root_path FROM workspaces WHERE id=?').get(id) as
    Pick<WorkspaceRow, 'root_path'> | undefined;
  return existing !== undefined && existing.root_path === null;
}

export interface RegisterWorkspaceInput {
  id: string;
  name: string;
  rootPath: string;
  actor: string | null;
}

/** A Workspace that arrived through synchronization takes its local root instead of a duplicate. */
function attachRoot(ctx: StoreContext, input: RegisterWorkspaceInput, rootPath: string): void {
  ctx.database
    .prepare('UPDATE workspaces SET name=?,root_path=?,updated_at=? WHERE id=?')
    .run(input.name, rootPath, ctx.now(), input.id);
}

function insertWorkspace(ctx: StoreContext, input: RegisterWorkspaceInput, rootPath: string): void {
  const at = ctx.now();
  ctx.database
    .prepare('INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(input.id, input.name, rootPath, at, at);
  ctx.writeEvent({
    workspaceId: input.id,
    projectId: null,
    specId: null,
    targetType: 'workspace',
    targetId: input.id,
    eventType: 'workspace.created',
    actor: input.actor,
    data: { name: input.name, rootPath },
  });
}

export function registerWorkspace(ctx: StoreContext, input: RegisterWorkspaceInput): Workspace {
  ctx.syncWritable('workspace', input.id);
  const rootPath = realDirectory(input.rootPath);
  return ctx.conflictOnUnique(
    () =>
      ctx.runImmediate(() => {
        if (hasUnresolvedRoot(ctx, input.id)) attachRoot(ctx, input, rootPath);
        else insertWorkspace(ctx, input, rootPath);
        return getWorkspace(ctx, input.id);
      }),
    'Workspace id or root path already exists',
  );
}

export function listWorkspaces(ctx: StoreContext): Workspace[] {
  return ctx.rows<WorkspaceRow>('SELECT * FROM workspaces ORDER BY name,id', []).map(mapWorkspace);
}

export function getWorkspace(ctx: StoreContext, id: string): Workspace {
  return ctx.load<WorkspaceRow, Workspace>(
    'SELECT * FROM workspaces WHERE id=?',
    [id],
    `Workspace ${id}`,
    mapWorkspace,
  );
}

/**
 * The deepest registered Workspace whose root contains `inputPath`. Only rows with a local root
 * take part: `relative('', path)` would otherwise resolve against the daemon's cwd (H-05).
 */
export function resolveWorkspace(ctx: StoreContext, inputPath: string): Workspace {
  if (!isAbsolute(inputPath))
    throw new AppError('bad_request', 'Workspace path must be absolute', 400);
  let resolved: string;
  try {
    resolved = realpathSync(inputPath);
  } catch {
    throw new AppError('not_found', 'Workspace path does not exist', 404);
  }
  const match = ctx
    .rows<WorkspaceRow>('SELECT * FROM workspaces WHERE root_path IS NOT NULL ORDER BY name,id', [])
    .map(mapWorkspace)
    .filter((w) => {
      const child = relative(w.rootPath, resolved);
      return child === '' || (!child.startsWith('..') && !isAbsolute(child));
    })
    .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  if (!match) throw new AppError('not_found', `No registered workspace contains ${resolved}`, 404);
  return match;
}
