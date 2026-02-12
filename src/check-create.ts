/**
 * Check-create logic for entity deduplication
 *
 * Uses the check-create-check-delete pattern to handle race conditions
 * when multiple workers create the same entity simultaneously.
 */

import type { ArkeClient } from '@arke-institute/sdk';
import type { CheckCreateResult } from './types';
import { normalizeLabel } from './normalize';

/**
 * Lookup response type (not in SDK types yet)
 */
interface LookupResponse {
  entities: Array<{ id: string; created_at: string }>;
}

/**
 * Lookup entity by normalized label and type
 */
async function lookupByLabel(
  client: ArkeClient,
  collection: string,
  label: string,
  type: string
): Promise<{ id: string; created_at: string } | null> {
  // Note: /collections/{id}/entities/lookup is not yet typed in SDK
  const { data, error } = await (client.api.GET as Function)(
    '/collections/{id}/entities/lookup',
    {
      params: {
        path: { id: collection },
        query: { label, type, limit: 1 },
      },
    }
  );

  if (error) {
    console.warn(`[check-create] Lookup failed for "${label}" (${type}):`, error);
  }

  const typedData = data as LookupResponse | undefined;
  if (error || !typedData || typedData.entities.length === 0) {
    return null;
  }

  return {
    id: typedData.entities[0].id,
    created_at: typedData.entities[0].created_at,
  };
}

/**
 * Lookup all entities with matching normalized label and type
 * (for race condition detection)
 */
async function lookupAllByLabel(
  client: ArkeClient,
  collection: string,
  label: string,
  type: string
): Promise<Array<{ id: string; created_at: string }>> {
  // Note: /collections/{id}/entities/lookup is not yet typed in SDK
  const { data, error } = await (client.api.GET as Function)(
    '/collections/{id}/entities/lookup',
    {
      params: {
        path: { id: collection },
        query: { label, type, limit: 10 },
      },
    }
  );

  const typedData = data as LookupResponse | undefined;
  if (error || !typedData) {
    return [];
  }

  return typedData.entities.map((e: { id: string; created_at: string }) => ({
    id: e.id,
    created_at: e.created_at,
  }));
}

/**
 * Create a new entity
 */
async function createEntity(
  client: ArkeClient,
  collection: string,
  type: string,
  label: string
): Promise<{ id: string; created_at: string }> {
  console.log(`[check-create] Creating entity: "${label}" (${type}) in ${collection}`);

  const { data, error } = await client.api.POST('/entities', {
    body: {
      type,
      collection,
      properties: { label },
    },
  });

  if (error || !data) {
    console.error(`[check-create] Failed to create entity "${label}":`, error);
    throw new Error(`Failed to create entity: ${JSON.stringify(error)}`);
  }

  console.log(`[check-create] Created entity: ${data.id} for "${label}"`);
  return {
    id: data.id,
    created_at: data.created_at,
  };
}

/**
 * Delete an entity (for race condition losers)
 */
async function deleteEntity(client: ArkeClient, entityId: string): Promise<void> {
  const { error } = await client.api.DELETE('/entities/{id}', {
    params: { path: { id: entityId } },
  });

  if (error) {
    console.warn(`[check-create] Failed to delete duplicate entity ${entityId}:`, error);
  }
}

/**
 * Check if entity exists by normalized label, create if not.
 * Handles race conditions via check-create-check-delete pattern.
 *
 * Max 4 API calls per entity:
 * - Best case: 1 (check, exists)
 * - Common case: 2 (check, create)
 * - Rare case: 4 (check, create, check again, delete)
 */
export async function checkCreate(
  client: ArkeClient,
  collection: string,
  label: string,
  type: string
): Promise<CheckCreateResult> {
  const normalizedLabel = normalizeLabel(label);

  // Step 1: Check if exists
  const existing = await lookupByLabel(client, collection, normalizedLabel, type);
  if (existing) {
    return { entityId: existing.id, isNew: false, label, type };
  }

  // Step 2: Create
  const created = await createEntity(client, collection, type, label);

  // Step 3: Check again for race condition
  const allMatches = await lookupAllByLabel(client, collection, normalizedLabel, type);

  if (allMatches.length > 1) {
    // Race! Multiple entities with same label. Keep earliest by created_at, then by id.
    const sorted = allMatches.sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
    );
    const winner = sorted[0];

    if (winner.id !== created.id) {
      // Step 4: We lost - delete our duplicate
      console.log(
        `[check-create] Race detected for "${label}" (${type}), deleting duplicate ${created.id}, keeping ${winner.id}`
      );
      await deleteEntity(client, created.id);
      return { entityId: winner.id, isNew: false, label, type };
    }
  }

  // We won (or no race)
  return { entityId: created.id, isNew: true, label, type };
}

/**
 * Run operations with bounded concurrency
 */
async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const promise = fn(item).then((result) => {
      results.push(result);
    });

    const wrapped = promise.then(() => {
      executing.delete(wrapped);
    });

    executing.add(wrapped);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Deduplicate entities by normalized label + type
 */
function dedupeByLabelType(
  entities: Array<{ label: string; type: string }>
): Array<{ label: string; type: string }> {
  const seen = new Set<string>();
  const unique: Array<{ label: string; type: string }> = [];

  for (const entity of entities) {
    const key = `${entity.type}:${normalizeLabel(entity.label)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entity);
    }
  }

  return unique;
}

/**
 * Batch check-create with concurrency control and deduplication.
 */
export async function batchCheckCreate(
  client: ArkeClient,
  collection: string,
  entities: Array<{ label: string; type: string }>
): Promise<CheckCreateResult[]> {
  // Dedupe by normalized label + type
  const unique = dedupeByLabelType(entities);

  // Run with bounded concurrency (20 parallel)
  return runWithConcurrency(
    unique,
    (entity) => checkCreate(client, collection, entity.label, entity.type),
    20
  );
}
