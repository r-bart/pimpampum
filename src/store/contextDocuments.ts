import { randomUUID } from 'node:crypto';
import { isTerminalProjectState } from '../domainRules.js';
import { AppError } from '../errors.js';
import type {
  ContextDocument,
  ContextManifest,
  ContextManifestPage,
  ContextOwnerType,
  MarkdownPage,
} from '../types.js';
import { projectEvent } from './activity.js';
import { page } from './markdown.js';
import { getProject } from './projects.js';
import type { ContextManifestRow, ContextRow } from './rows.js';
import { requireRow, type StoreContext } from './storeContext.js';
import { getWorkspace } from './workspaces.js';

export interface ListContextManifestsInput {
  ownerType: ContextOwnerType;
  ownerId: string;
  limit: number;
  offset: number;
}
export interface PutContextInput {
  ownerType: ContextOwnerType;
  ownerId: string;
  name: string;
  body: string;
  /** `null` creates; a number updates that revision. */
  expectedRevision: number | null;
  actor: string | null;
}

/** The Work bundle carries at most this many Context manifests per owner. */
const CONTEXT_PAGE = 200;

function ownerColumn(type: ContextOwnerType): 'workspace_id' | 'project_id' {
  return type === 'workspace' ? 'workspace_id' : 'project_id';
}

export function mapContext(r: ContextRow): ContextDocument {
  const ownerType: ContextOwnerType = r.workspace_id === null ? 'project' : 'workspace',
    ownerId = r.workspace_id ?? requireRow(r.project_id, 'Context owner was not found');
  return {
    id: r.id,
    ownerType,
    ownerId,
    name: r.name,
    body: r.body,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapContextManifest(r: ContextManifestRow): ContextManifest {
  const { body: _body, ...base } = mapContext(r);
  return { ...base, sizeBytes: r.size_bytes };
}

function assertOwner(ctx: StoreContext, type: ContextOwnerType, id: string): void {
  if (type === 'workspace') getWorkspace(ctx, id);
  else getProject(ctx, id);
}

function assertOwnerMutable(ctx: StoreContext, type: ContextOwnerType, id: string): void {
  assertOwner(ctx, type, id);
  if (type === 'project' && isTerminalProjectState(getProject(ctx, id).state))
    throw new AppError('invalid_state', 'Context in terminal Projects is immutable', 409);
}

export function listContextManifests(
  ctx: StoreContext,
  input: ListContextManifestsInput,
): ContextManifest[] {
  assertOwner(ctx, input.ownerType, input.ownerId);
  return ctx
    .rows<ContextManifestRow>(
      `SELECT *,length(CAST(body AS BLOB)) AS size_bytes FROM context_documents WHERE ${ownerColumn(input.ownerType)}=? ORDER BY name,id LIMIT ? OFFSET ?`,
      [input.ownerId, input.limit, input.offset],
    )
    .map(mapContextManifest);
}

/** The first page of an owner's manifests, flagged when more exist. */
export function contextManifestPage(
  ctx: StoreContext,
  type: ContextOwnerType,
  id: string,
): ContextManifestPage {
  const items = listContextManifests(ctx, {
    ownerType: type,
    ownerId: id,
    limit: CONTEXT_PAGE + 1,
    offset: 0,
  });
  return { items: items.slice(0, CONTEXT_PAGE), hasMore: items.length > CONTEXT_PAGE };
}

export function getContextManifest(
  ctx: StoreContext,
  ownerType: ContextOwnerType,
  ownerId: string,
  name: string,
): ContextManifest {
  assertOwner(ctx, ownerType, ownerId);
  return ctx.load<ContextManifestRow, ContextManifest>(
    `SELECT *,length(CAST(body AS BLOB)) size_bytes FROM context_documents WHERE ${ownerColumn(ownerType)}=? AND name=?`,
    [ownerId, name],
    `Context document ${name}`,
    mapContextManifest,
  );
}

export function readContext(
  ctx: StoreContext,
  ownerType: ContextOwnerType,
  ownerId: string,
  name: string,
): ContextDocument {
  assertOwner(ctx, ownerType, ownerId);
  return ctx.load<ContextRow, ContextDocument>(
    `SELECT * FROM context_documents WHERE ${ownerColumn(ownerType)}=? AND name=?`,
    [ownerId, name],
    `Context document ${name}`,
    mapContext,
  );
}

export function readContextPage(
  ctx: StoreContext,
  ownerType: ContextOwnerType,
  ownerId: string,
  name: string,
  offset: number,
  limit: number,
): MarkdownPage {
  return page(readContext(ctx, ownerType, ownerId, name).body, offset, limit);
}

/** Replaces the body of `existing` at the expected revision. */
function updateContextBody(
  ctx: StoreContext,
  existing: ContextRow,
  input: PutContextInput,
  at: string,
): void {
  if (input.expectedRevision === null)
    throw new AppError('conflict', 'Context document already exists', 409);
  ctx.revision(existing.revision, input.expectedRevision);
  ctx.bumpRevision({
    table: 'context_documents',
    id: existing.id,
    expectedRevision: input.expectedRevision,
    at,
    set: { body: input.body },
  });
}

function insertContext(ctx: StoreContext, input: PutContextInput, at: string): void {
  if (input.expectedRevision !== null)
    throw new AppError('not_found', `Context document ${input.name} was not found`, 404);
  ctx.database
    .prepare(
      'INSERT INTO context_documents (id,workspace_id,project_id,name,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      randomUUID(),
      input.ownerType === 'workspace' ? input.ownerId : null,
      input.ownerType === 'project' ? input.ownerId : null,
      input.name,
      input.body,
      at,
      at,
    );
}

function recordContextPut(ctx: StoreContext, input: PutContextInput, documentId: string): void {
  const data = { ownerType: input.ownerType, ownerId: input.ownerId, name: input.name };
  if (input.ownerType === 'workspace')
    ctx.writeEvent({
      workspaceId: input.ownerId,
      projectId: null,
      specId: null,
      targetType: 'context',
      targetId: documentId,
      eventType: 'context.put',
      actor: input.actor,
      data,
    });
  else
    projectEvent(ctx, input.ownerId, 'context.put', input.actor, { targetId: documentId, ...data });
}

/** Creates (`expectedRevision: null`) or replaces (`expectedRevision: n`) one named document. */
export function putContext(ctx: StoreContext, input: PutContextInput): ContextDocument {
  ctx.syncWritable(input.ownerType, input.ownerId);
  return ctx.runImmediate(() => {
    assertOwnerMutable(ctx, input.ownerType, input.ownerId);
    const existing = ctx.database
      .prepare(`SELECT * FROM context_documents WHERE ${ownerColumn(input.ownerType)}=? AND name=?`)
      .get(input.ownerId, input.name) as ContextRow | undefined;
    if (existing) ctx.syncWritable('context', existing.id);
    const at = ctx.now();
    if (existing) updateContextBody(ctx, existing, input, at);
    else insertContext(ctx, input, at);
    const document = readContext(ctx, input.ownerType, input.ownerId, input.name);
    recordContextPut(ctx, input, document.id);
    return document;
  });
}
