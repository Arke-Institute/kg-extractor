/**
 * Main job processing logic for KG extraction
 *
 * Two-phase processing:
 * 1. Sync: Gemini extraction + check-create entities
 * 2. Async: Fire updates via /updates/additive
 */

import type { KladosJob } from '@arke-institute/rhiza';
import { createKladosError, KladosErrorCode } from '@arke-institute/rhiza';
import type {
  Env,
  TargetProperties,
  ParsedOperations,
  AdditiveUpdate,
  SourceRef,
} from './types';
import { callGemini } from './gemini';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts';
import { parseOperations, collectReferencedLabels } from './parse';
import { batchCheckCreate } from './check-create';

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
  job: KladosJob,
  entityId: string,
  properties: TargetProperties
): Promise<string | null> {
  // Prefer properties.content if available
  if (properties.content && typeof properties.content === 'string') {
    return properties.content;
  }

  // Try fetching from content endpoint
  const { data, error } = await job.client.api.GET('/entities/{id}/content', {
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
 */
function buildUpdates(
  operations: ParsedOperations,
  labelToId: Map<string, string>,
  sourceRef: SourceRef
): AdditiveUpdate[] {
  // Group updates by entity ID
  const updatesByEntity = new Map<string, AdditiveUpdate>();

  // Process property operations
  for (const propOp of operations.properties) {
    const entityId = labelToId.get(propOp.entity);
    if (!entityId) {
      console.warn(`[buildUpdates] No entity ID for label "${propOp.entity}", skipping property`);
      continue;
    }

    if (!updatesByEntity.has(entityId)) {
      updatesByEntity.set(entityId, {
        entity_id: entityId,
        properties: {},
        relationships_add: [],
      });
    }

    const update = updatesByEntity.get(entityId)!;
    update.properties![propOp.key] = propOp.value;
  }

  // Process relationship operations
  for (const relOp of operations.relationships) {
    const subjectId = labelToId.get(relOp.subject);
    const targetId = labelToId.get(relOp.target);

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

    if (!updatesByEntity.has(subjectId)) {
      updatesByEntity.set(subjectId, {
        entity_id: subjectId,
        properties: {},
        relationships_add: [],
      });
    }

    const update = updatesByEntity.get(subjectId)!;
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
async function fireUpdates(job: KladosJob, updates: AdditiveUpdate[]): Promise<void> {
  if (updates.length === 0) return;

  // Batch if > 1000 (API limit)
  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);

    // Fire and forget - don't await completion
    // Note: /updates/additive is not yet typed in SDK
    (job.client.api.POST as Function)('/updates/additive', {
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
export async function processJob(job: KladosJob, env: Env): Promise<string[]> {
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Fetch Target Content
  // ═══════════════════════════════════════════════════════════════════════════
  job.log.info('Starting extraction');

  const target = await job.fetchTarget<TargetProperties>();
  const text = await fetchTextContent(job, target.id, target.properties);

  if (!text || text.length < 50) {
    throw createKladosError(
      KladosErrorCode.INVALID_INPUT,
      'Target entity has no text content or content is too short'
    );
  }

  if (text.length > MAX_TEXT_SIZE) {
    throw createKladosError(
      KladosErrorCode.INVALID_INPUT,
      `Text content exceeds maximum size (${Math.round(text.length / 1024)}KB > ${MAX_TEXT_SIZE / 1024}KB)`
    );
  }

  if (text.length > WARN_TEXT_SIZE) {
    job.log.info('Large text content', { sizeKB: Math.round(text.length / 1024) });
  }

  job.log.info('Fetched target', {
    id: target.id,
    type: target.type,
    label: target.properties.label,
    textLength: text.length,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Call Gemini
  // ═══════════════════════════════════════════════════════════════════════════
  job.log.info('Calling Gemini');

  const sourceLabel = target.properties.label || 'Source';
  const response = await callGemini(
    SYSTEM_PROMPT,
    buildUserPrompt(text, { id: target.id, label: sourceLabel }),
    env.GEMINI_API_KEY
  );

  job.log.info('Gemini response received', {
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
    job.log.error('Failed to parse LLM response', {
      error: e instanceof Error ? e.message : String(e),
      responsePreview: response.content.slice(0, 500),
    });
    throw createKladosError(
      KladosErrorCode.PROCESSING_ERROR,
      `Failed to parse LLM response: ${e instanceof Error ? e.message : e}`
    );
  }

  // Auto-create implicitly referenced entities (mentioned in properties/relationships but not created)
  const allLabels = collectReferencedLabels(operations);
  const explicitLabels = new Set(operations.creates.map((c) => c.label));

  for (const label of allLabels) {
    if (!explicitLabels.has(label)) {
      operations.creates.push({ op: 'create', label, entity_type: 'entity' });
    }
  }

  job.log.info('Parsed operations', {
    creates: operations.creates.length,
    properties: operations.properties.length,
    relationships: operations.relationships.length,
  });

  // Handle empty extraction
  if (operations.creates.length === 0) {
    job.log.info('No entities to extract');
    job.log.success('Extraction complete (no entities)');
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Check-Create Entities (SYNCHRONOUS)
  // ═══════════════════════════════════════════════════════════════════════════
  job.log.info('Check-creating entities', { count: operations.creates.length });

  const entitiesToCreate = operations.creates.map((c) => ({
    label: c.label,
    type: c.entity_type,
  }));

  const results = await batchCheckCreate(
    job.client,
    job.request.target_collection,
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

  job.log.info('Check-create complete', {
    total: results.length,
    new: newEntityIds.length,
    existing: results.length - newEntityIds.length,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Fire Updates (FIRE-AND-FORGET via /updates/additive)
  // ═══════════════════════════════════════════════════════════════════════════
  const sourceRef: SourceRef = {
    pi: target.id,
    type: target.type,
    label: sourceLabel,
  };

  const updates = buildUpdates(operations, labelToId, sourceRef);

  if (updates.length > 0) {
    const totalRelationships = updates.reduce(
      (sum, u) => sum + (u.relationships_add?.length || 0),
      0
    );
    const totalProperties = updates.reduce(
      (sum, u) => sum + Object.keys(u.properties || {}).length,
      0
    );

    job.log.info('Firing updates via /updates/additive', {
      entityCount: updates.length,
      properties: totalProperties,
      relationships: totalRelationships,
    });

    await fireUpdates(job, updates);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Return New Entity IDs for Handoff
  // ═══════════════════════════════════════════════════════════════════════════
  job.log.success('Extraction complete', {
    totalEntities: results.length,
    newEntities: newEntityIds.length,
    existingEntities: results.length - newEntityIds.length,
  });

  // Only pass NEW entities to next step
  return newEntityIds;
}
