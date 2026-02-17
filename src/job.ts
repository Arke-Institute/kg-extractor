/**
 * Job Processing Logic for KG Extraction (v2 - Durable Object based)
 *
 * Two-phase processing:
 * 1. Sync: Gemini extraction + check-create entities
 * 2. Async: Fire updates via /updates/additive
 *
 * Unlike Tier 1 workers, this can take arbitrarily long (via alarm rescheduling).
 */

import type { ArkeClient } from '@arke-institute/sdk';
import type { KladosLogger, KladosRequest, Output } from '@arke-institute/rhiza';
import type {
  Env,
  TargetProperties,
  ParsedOperations,
  AdditiveUpdate,
  SourceRef,
  EntityContext,
  RelationshipWithPreview,
} from './types';
import { callGemini } from './gemini';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts';
import { parseOperations, collectReferencedLabels } from './parse';
import { batchCheckCreate } from './check-create';
import { normalizeLabel } from './normalize';

/**
 * Context provided to processJob
 */
export interface ProcessContext {
  /** The original request */
  request: KladosRequest;

  /** Arke client for API calls */
  client: ArkeClient;

  /** Logger for messages (stored in the klados_log) */
  logger: KladosLogger;

  /** SQLite storage for checkpointing long operations */
  sql: SqlStorage;

  /** Worker environment bindings (secrets, vars, DO namespaces) */
  env: Env;
}

/**
 * Result returned from processJob
 */
export interface ProcessResult {
  /** Output entity IDs (or OutputItems with routing properties) */
  outputs?: Output[];

  /** If true, DO will reschedule alarm and call processJob again */
  reschedule?: boolean;
}

/**
 * Maximum text size (500KB)
 */
const MAX_TEXT_SIZE = 500 * 1024;

/**
 * Warning threshold for text size (100KB)
 */
const WARN_TEXT_SIZE = 100 * 1024;

/**
 * Batch size for /updates/additive (API limit is 1000)
 */
const UPDATE_BATCH_SIZE = 1000;

/**
 * Fetch text content from entity (either from properties or content endpoint)
 */
async function fetchTextContent(
  client: ArkeClient,
  entityId: string,
  properties: TargetProperties
): Promise<string | null> {
  // Prefer properties.text if available
  if (properties.text && typeof properties.text === 'string') {
    return properties.text;
  }

  // Fall back to properties.content for backward compatibility
  if (properties.content && typeof properties.content === 'string') {
    return properties.content;
  }

  // Try fetching from content endpoint
  const { data, error } = await client.api.GET('/entities/{id}/content', {
    params: {
      path: { id: entityId },
      query: { key: 'content' },
    },
  });

  if (error || !data) {
    return null;
  }

  // Content endpoint returns binary, need to decode as text
  if (typeof data === 'string') {
    return data;
  }

  return null;
}

/**
 * Build updates for /updates/additive from parsed operations
 *
 * Consolidates ALL updates per entity:
 * - Properties from LLM
 * - Outgoing relationships from LLM
 * - extracted_from → source chunk (for provenance)
 * - referenced_by → for orphan entities (only targets, no subjects)
 */
function buildUpdates(
  operations: ParsedOperations,
  labelToId: Map<string, string>,
  sourceRef: SourceRef,
  sourceChunkId: string
): AdditiveUpdate[] {
  // Track all updates by entity ID
  const updatesByEntity = new Map<string, AdditiveUpdate>();

  // Helper to get or create update for an entity
  const getUpdate = (entityId: string): AdditiveUpdate => {
    if (!updatesByEntity.has(entityId)) {
      updatesByEntity.set(entityId, {
        entity_id: entityId,
        properties: {},
        relationships_add: [],
      });
    }
    return updatesByEntity.get(entityId)!;
  };

  // Track which entities are subjects vs only targets
  const subjects = new Set<string>();
  const targets = new Set<string>();

  // Process property operations
  for (const propOp of operations.properties) {
    const entityId = labelToId.get(normalizeLabel(propOp.entity));
    if (!entityId) {
      console.warn(`[buildUpdates] No entity ID for label "${propOp.entity}", skipping property`);
      continue;
    }

    const update = getUpdate(entityId);
    update.properties![propOp.key] = propOp.value;
  }

  // Process relationship operations
  for (const relOp of operations.relationships) {
    const subjectId = labelToId.get(normalizeLabel(relOp.subject));
    const targetId = labelToId.get(normalizeLabel(relOp.target));

    if (!subjectId) {
      console.warn(
        `[buildUpdates] No entity ID for subject "${relOp.subject}", skipping relationship`
      );
      continue;
    }
    if (!targetId) {
      console.warn(
        `[buildUpdates] No entity ID for target "${relOp.target}", skipping relationship`
      );
      continue;
    }

    subjects.add(subjectId);
    targets.add(targetId);

    // Add outgoing relationship to subject
    const update = getUpdate(subjectId);
    update.relationships_add!.push({
      predicate: relOp.predicate,
      peer: targetId,
      peer_label: relOp.target,
      direction: 'outgoing',
      properties: {
        description: relOp.description || '',
        source: sourceRef,
        source_text: relOp.source_text,
        confidence: relOp.confidence ?? 1.0,
        context: relOp.context,
      },
    });
  }

  // Add referenced_by for orphan targets (targets that aren't subjects)
  // This ensures every entity has at least one meaningful outgoing relationship
  for (const relOp of operations.relationships) {
    const subjectId = labelToId.get(normalizeLabel(relOp.subject));
    const targetId = labelToId.get(normalizeLabel(relOp.target));
    if (!subjectId || !targetId) continue;

    // If target has no outgoing relationships, add referenced_by
    if (!subjects.has(targetId)) {
      const update = getUpdate(targetId);
      update.relationships_add!.push({
        predicate: 'referenced_by',
        peer: subjectId,
        peer_label: relOp.subject,
        direction: 'outgoing',
        properties: {
          context: relOp.predicate, // What kind of reference
          source_text: relOp.source_text,
          source: sourceRef,
        },
      });
    }
  }

  // Add extracted_from to ALL entities (enables traversal back to source chunk)
  for (const [entityId, update] of updatesByEntity) {
    update.relationships_add!.push({
      predicate: 'extracted_from',
      peer: sourceChunkId,
      peer_label: sourceRef.label,
      direction: 'outgoing',
      properties: {
        extracted_at: new Date().toISOString(),
        source: sourceRef,
      },
    });
  }

  return Array.from(updatesByEntity.values());
}

/**
 * Response type for /updates/additive (not in SDK types yet)
 */
interface AdditiveResponse {
  accepted: number;
}

/**
 * Fire updates via /updates/additive (fire-and-forget)
 */
async function fireUpdates(client: ArkeClient, updates: AdditiveUpdate[]): Promise<void> {
  if (updates.length === 0) return;

  // Batch if > 1000 (API limit)
  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);

    // Fire and forget - don't await completion
    // Note: /updates/additive is not yet typed in SDK
    (client.api.POST as Function)('/updates/additive', {
      body: { updates: batch },
    })
      .then((result: { error?: unknown; data?: AdditiveResponse }) => {
        if (result.error) {
          console.error('[fireUpdates] Batch failed:', result.error);
        } else {
          console.log(`[fireUpdates] Batch accepted: ${result.data?.accepted || batch.length}`);
        }
      })
      .catch((err: unknown) => {
        console.error('[fireUpdates] Batch error:', err);
      });
  }
}

/**
 * Process a job and return output entity IDs (newly created entities only)
 */
export async function processJob(ctx: ProcessContext): Promise<ProcessResult> {
  const { request, client, logger, env } = ctx;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Fetch Target Content
  // ═══════════════════════════════════════════════════════════════════════════
  logger.info('Starting extraction');

  if (!request.target_entity) {
    throw new Error('No target_entity in request');
  }

  const { data: target, error: fetchError } = await client.api.GET('/entities/{id}', {
    params: {
      path: { id: request.target_entity },
      query: { expand: 'relationships:preview' },
    },
  });

  if (fetchError || !target) {
    throw new Error(`Failed to fetch target: ${request.target_entity}`);
  }

  const properties = target.properties as TargetProperties;
  const text = await fetchTextContent(client, target.id, properties);

  if (!text || text.length < 50) {
    throw new Error('Target entity has no text content or content is too short');
  }

  if (text.length > MAX_TEXT_SIZE) {
    throw new Error(
      `Text content exceeds maximum size (${Math.round(text.length / 1024)}KB > ${MAX_TEXT_SIZE / 1024}KB)`
    );
  }

  if (text.length > WARN_TEXT_SIZE) {
    logger.info('Large text content', { sizeKB: Math.round(text.length / 1024) });
  }

  logger.info('Fetched target', {
    id: target.id,
    type: target.type,
    label: properties.label,
    textLength: text.length,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Call Gemini
  // ═══════════════════════════════════════════════════════════════════════════
  logger.info('Calling Gemini');

  const sourceLabel = properties.label || 'Source';

  // Build entity context for the prompt (includes relationships with previews)
  const entityContext: EntityContext = {
    id: target.id,
    type: target.type,
    label: sourceLabel,
    description: properties.description as string | undefined,
    properties: properties,
    relationships: (target.relationships || []) as RelationshipWithPreview[],
  };

  const response = await callGemini(
    SYSTEM_PROMPT,
    buildUserPrompt(text, entityContext),
    env.GEMINI_API_KEY
  );

  logger.info('Gemini response received', {
    tokens: response.tokens,
    promptTokens: response.prompt_tokens,
    completionTokens: response.completion_tokens,
    cost: `$${response.cost_usd.toFixed(4)}`,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Parse Operations
  // ═══════════════════════════════════════════════════════════════════════════
  let operations: ParsedOperations;
  try {
    operations = parseOperations(response.content);
  } catch (e) {
    logger.error('Failed to parse LLM response', {
      error: e instanceof Error ? e.message : String(e),
      responsePreview: response.content.slice(0, 500),
    });
    throw new Error(
      `Failed to parse LLM response: ${e instanceof Error ? e.message : e}`
    );
  }

  // Auto-create implicitly referenced entities (mentioned in properties/relationships but not created)
  // Use normalized labels to handle case differences (LLM might output "Night" in relationship but "night" in create)
  const allLabels = collectReferencedLabels(operations);
  const explicitLabels = new Set(operations.creates.map((c) => normalizeLabel(c.label)));

  for (const label of allLabels) {
    const normalized = normalizeLabel(label);
    if (!explicitLabels.has(normalized)) {
      explicitLabels.add(normalized); // Prevent duplicate auto-creates for case variants
      operations.creates.push({ op: 'create', label: normalized, entity_type: 'entity' });
    }
  }

  logger.info('Parsed operations', {
    creates: operations.creates.length,
    properties: operations.properties.length,
    relationships: operations.relationships.length,
  });

  // Handle empty extraction
  if (operations.creates.length === 0) {
    logger.info('No entities to extract');
    logger.success('Extraction complete (no entities)');
    return { outputs: [] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Check-Create Entities (SYNCHRONOUS)
  // ═══════════════════════════════════════════════════════════════════════════
  logger.info('Check-creating entities', { count: operations.creates.length });

  const entitiesToCreate = operations.creates.map((c) => ({
    label: c.label,
    type: c.entity_type,
  }));

  const results = await batchCheckCreate(
    client,
    request.target_collection,
    entitiesToCreate
  );

  // Build label → ID mapping
  const labelToId = new Map<string, string>();
  const newEntityIds: string[] = [];

  for (const result of results) {
    labelToId.set(result.label, result.entityId);
    if (result.isNew) {
      newEntityIds.push(result.entityId);
    }
  }

  logger.info('Check-create complete', {
    total: results.length,
    new: newEntityIds.length,
    existing: results.length - newEntityIds.length,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Fire Updates (FIRE-AND-FORGET via /updates/additive)
  // ═══════════════════════════════════════════════════════════════════════════
  const sourceRef: SourceRef = {
    id: target.id,
    type: target.type,
    label: sourceLabel,
  };

  const updates = buildUpdates(operations, labelToId, sourceRef, target.id);

  // Add source → extracted entity relationships (enables traversal from source text)
  if (results.length > 0) {
    updates.push({
      entity_id: target.id,
      relationships_add: results.map((r) => ({
        predicate: 'extracted_entity',
        peer: r.entityId,
        peer_label: r.label,
        direction: 'outgoing' as const,
        properties: {
          extracted_at: new Date().toISOString(),
          entity_type: r.type,
        },
      })),
    });
  }

  // Add collection → chunk relationship (enables auditing which chunks were processed)
  updates.push({
    entity_id: request.target_collection,
    relationships_add: [{
      predicate: 'contains',
      peer: target.id,
      peer_label: sourceLabel,
      direction: 'outgoing' as const,
      properties: {
        relationship_type: 'processed_chunk',
        processed_at: new Date().toISOString(),
      },
    }],
  });

  if (updates.length > 0) {
    const totalRelationships = updates.reduce(
      (sum, u) => sum + (u.relationships_add?.length || 0),
      0
    );
    const totalProperties = updates.reduce(
      (sum, u) => sum + Object.keys(u.properties || {}).length,
      0
    );

    logger.info('Firing updates via /updates/additive', {
      entityCount: updates.length,
      properties: totalProperties,
      relationships: totalRelationships,
    });

    await fireUpdates(client, updates);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Return New Entity IDs for Handoff
  // ═══════════════════════════════════════════════════════════════════════════
  logger.success('Extraction complete', {
    totalEntities: results.length,
    newEntities: newEntityIds.length,
    existingEntities: results.length - newEntityIds.length,
  });

  // Only pass NEW entities to next step
  return { outputs: newEntityIds };
}
