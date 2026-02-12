# Knowledge Graph Extraction Worker - Implementation Plan

A Cloudflare Worker that extracts entities and relationships from text using Gemini, creates them in Arke, and passes newly-created entities to the next workflow step.

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           KG-EXTRACTOR WORKER                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  PHASE 1: Synchronous (in worker)                                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Fetch       │    │  Call        │    │  Parse       │    │  Check-      │  │
│  │  Target      │───▶│  Gemini      │───▶│  Operations  │───▶│  Create      │  │
│  │  Content     │    │  (~60s)      │    │              │    │  Entities    │  │
│  └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                                    │            │
│                                                          We know what's new     │
│                                                                    │            │
│  PHASE 2: Fire-and-Forget via Arke API                             ▼            │
│  ┌──────────────┐    ┌──────────────────────────────────────────────────────┐  │
│  │  Scatter     │◀───│  POST /updates/additive                              │  │
│  │  Handoff     │    │  (properties + relationships - async, don't wait)    │  │
│  │  (new only)  │    │                                                      │  │
│  └──────────────┘    └──────────────────────────────────────────────────────┘  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** Two distinct phases:
1. **Phase 1 (Sync):** Gemini + check-create → we know exactly what we created
2. **Phase 2 (Async):** Fire updates via `POST /updates/additive` → 202 Accepted, don't wait

**No custom utility needed!** Arke's `POST /updates/additive` handles:
- Fire-and-forget (202 Accepted immediately)
- CAS retry with exponential backoff internally
- Deep merge for properties
- Upsert for relationships (by predicate+peer)
- Up to 1,000 updates per request

## 2. File Structure

```
arke-kladoi/knowledge-graph/kg-extractor/
├── src/
│   ├── index.ts            # Hono router, endpoints
│   ├── job.ts              # processJob() - main extraction logic
│   ├── gemini.ts           # Gemini client with retry
│   ├── prompts.ts          # System prompt, user prompt builder
│   ├── types.ts            # Type definitions
│   ├── parse.ts            # Parse LLM output, validate operations
│   ├── check-create.ts     # Entity check-create logic
│   └── normalize.ts        # Label normalization
├── agent.json              # Klados metadata
├── wrangler.jsonc          # Cloudflare config
├── package.json            # Dependencies
├── tsconfig.json           # TypeScript config
├── test/
│   ├── extractor.test.ts   # E2E test
│   └── fixtures/           # Test text samples
├── scripts/
│   └── register.ts         # Registration script
└── PLAN.md                 # This document
```

## 3. POST /updates/additive - The Key Endpoint

```typescript
// Fire-and-forget batch updates
const response = await client.api.POST('/updates/additive', {
  body: {
    updates: [
      {
        entity_id: 'entity_ahab_123',
        properties: {
          title: 'Captain',
          role: 'Commander of the Pequod',
        },
        relationships_add: [
          {
            predicate: 'hunts',
            peer: 'entity_moby_dick_456',
            peer_label: 'Moby Dick',
            properties: {
              description: 'Obsessive pursuit of the white whale',
              source_text: "I'll chase him round Good Hope...",
              confidence: 1.0,
            },
          },
        ],
      },
      // ... more updates
    ],
  },
});

// Returns immediately with 202 Accepted
// { accepted: 150 }
```

**Characteristics:**
| Feature | Behavior |
|---------|----------|
| Response | 202 Accepted immediately |
| Max batch | 1,000 updates per request |
| CAS handling | Internal retry with exponential backoff |
| Properties | Deep merge (nested objects preserved) |
| Relationships | Upsert by predicate+peer, properties merged |

**Per-Actor Versioning:** Updates merge by (entity_id, actor_id):
- Same klados worker updating same entity → 1 version
- Different workers updating same entity → separate versions (audit trail preserved)

## 4. Phase 1: Check-Create Logic

The check-create pattern runs synchronously in the worker. Max 4 API calls per entity:

```typescript
// src/check-create.ts

interface CheckCreateResult {
  entityId: string;
  isNew: boolean;
  label: string;
  type: string;
}

/**
 * Check if entity exists by normalized label, create if not.
 * Handles race conditions via check-create-check-delete pattern.
 */
async function checkCreate(
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
  const created = await createEntity(client, collection, {
    type,
    properties: { label },
  });

  // Step 3: Check again for race condition
  const allMatches = await lookupByLabel(client, collection, normalizedLabel, type);
  if (allMatches.length > 1) {
    // Race! Multiple entities with same label. Keep earliest.
    const sorted = allMatches.sort((a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
    );
    const winner = sorted[0];

    if (winner.id !== created.id) {
      // Step 4: We lost - delete our duplicate
      await deleteEntity(client, created.id);
      return { entityId: winner.id, isNew: false, label, type };
    }
  }

  // We won (or no race)
  return { entityId: created.id, isNew: true, label, type };
}

/**
 * Batch check-create with concurrency control.
 */
async function batchCheckCreate(
  client: ArkeClient,
  collection: string,
  entities: Array<{ label: string; type: string }>
): Promise<CheckCreateResult[]> {
  // Dedupe by normalized label + type
  const unique = dedupeByLabelType(entities);

  // Run with bounded concurrency (e.g., 20 parallel)
  return runWithConcurrency(
    unique,
    (entity) => checkCreate(client, collection, entity.label, entity.type),
    20
  );
}
```

**API calls per entity:**
- Best case: 1 (check, exists)
- Common case: 2 (check, create)
- Rare case: 4 (check, create, check again, delete)

## 5. Phase 2: Fire-and-Forget Updates

After check-create, we have entity IDs. Now fire updates via `POST /updates/additive`:

```typescript
// In job.ts

// Build updates from parsed operations
const updates: AdditiveUpdate[] = [];

// Group by entity ID for efficiency
const updatesByEntity = new Map<string, AdditiveUpdate>();

for (const propOp of operations.properties) {
  const entityId = labelToId.get(propOp.entity);
  if (!entityId) continue;

  if (!updatesByEntity.has(entityId)) {
    updatesByEntity.set(entityId, { entity_id: entityId, properties: {}, relationships_add: [] });
  }
  const update = updatesByEntity.get(entityId)!;
  update.properties![propOp.key] = propOp.value;
}

for (const relOp of operations.relationships) {
  const subjectId = labelToId.get(relOp.subject);
  const targetId = labelToId.get(relOp.target);
  if (!subjectId || !targetId) continue;

  if (!updatesByEntity.has(subjectId)) {
    updatesByEntity.set(subjectId, { entity_id: subjectId, properties: {}, relationships_add: [] });
  }
  const update = updatesByEntity.get(subjectId)!;
  update.relationships_add!.push({
    predicate: relOp.predicate,
    peer: targetId,
    peer_label: relOp.target,
    direction: 'outgoing',
    properties: {
      description: relOp.description,
      source: {
        pi: target.id,
        type: target.type,
        label: target.properties.label,
      },
      source_text: relOp.source_text,
      confidence: relOp.confidence,
      context: relOp.context,
    },
  });
}

const allUpdates = Array.from(updatesByEntity.values());

// Fire and forget - batch if > 1000
job.log.info('Firing updates via /updates/additive', { count: allUpdates.length });

const BATCH_SIZE = 1000;
for (let i = 0; i < allUpdates.length; i += BATCH_SIZE) {
  const batch = allUpdates.slice(i, i + BATCH_SIZE);

  // Don't await - fire and forget
  job.client.api.POST('/updates/additive', {
    body: { updates: batch },
  }).catch(err => {
    // Log but don't fail - updates will eventually succeed
    console.error('Additive update batch failed:', err);
  });
}
```

## 6. Processing Flow (Step by Step)

```typescript
// src/job.ts

export async function processJob(job: KladosJob): Promise<string[]> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Fetch Target Content
  // ═══════════════════════════════════════════════════════════════════════
  job.log.info('Starting extraction');

  const target = await job.fetchTarget<TargetProperties>();
  const text = target.properties.content
    || await fetchContent(job.client, target.id);

  if (!text || text.length < 50) {
    throw createKladosError(KladosErrorCode.INVALID_INPUT, 'No text content');
  }

  job.log.info('Fetched target', { textLength: text.length });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Call Gemini
  // ═══════════════════════════════════════════════════════════════════════
  job.log.info('Calling Gemini');

  const response = await callGemini(
    buildSystemPrompt(),
    buildUserPrompt(text, target),
    env.GEMINI_API_KEY
  );

  job.log.info('Gemini response', {
    tokens: response.tokens,
    cost: `$${response.cost_usd.toFixed(4)}`,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Parse Operations
  // ═══════════════════════════════════════════════════════════════════════
  const operations = parseOperations(response.content);

  // Auto-create implicitly referenced entities
  const allLabels = collectReferencedLabels(operations);
  const explicitLabels = new Set(operations.creates.map(c => c.label));

  for (const label of allLabels) {
    if (!explicitLabels.has(label)) {
      operations.creates.push({ label, type: 'entity' });
    }
  }

  job.log.info('Parsed operations', {
    creates: operations.creates.length,
    properties: operations.properties.length,
    relationships: operations.relationships.length,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: Check-Create Entities (SYNCHRONOUS)
  // ═══════════════════════════════════════════════════════════════════════
  job.log.info('Check-creating entities');

  const results = await batchCheckCreate(
    job.client,
    job.request.target_collection,
    operations.creates
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

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: Fire Updates (FIRE-AND-FORGET via /updates/additive)
  // ═══════════════════════════════════════════════════════════════════════
  const updates = buildUpdates(operations, labelToId, target);

  if (updates.length > 0) {
    job.log.info('Firing updates via /updates/additive', { count: updates.length });

    // Batch if > 1000 (API limit)
    const BATCH_SIZE = 1000;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      // Fire and forget - don't await
      job.client.api.POST('/updates/additive', {
        body: { updates: batch },
      }).catch(err => console.error('Additive update failed:', err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 6: Return New Entity IDs for Handoff
  // ═══════════════════════════════════════════════════════════════════════
  job.log.success('Extraction complete', {
    totalEntities: results.length,
    newEntities: newEntityIds.length,
    updates: updates.length,
  });

  // Only pass NEW entities to next step
  return newEntityIds;
}
```

## 7. Handoff Logic

| Entity Status | Pass to Next Step? | Reason |
|---------------|-------------------|--------|
| New (we created) | YES | We're responsible for it |
| Existing | NO | Its creating worker handles it |

The workflow definition:
```json
{
  "entry": "extract",
  "flow": {
    "extract": {
      "klados": { "pi": "kg-extractor" },
      "then": { "scatter": "dedupe" }
    },
    "dedupe": {
      "klados": { "pi": "kg-dedupe-resolver" },
      "then": { "pass": "trim" }
    }
  }
}
```

## 8. Gemini Integration

```typescript
// src/gemini.ts

const MODEL = 'gemini-2.5-flash';
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 120000;
const BASE_DELAY_MS = 15000;
const MAX_DELAY_MS = 120000;

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string
): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      maxOutputTokens: 32768,
      temperature: 0.7,
      responseMimeType: 'application/json',
    },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 429 || response.status >= 500) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Gemini error: ${response.status}`);
      }

      const data = await response.json();
      return parseGeminiResponse(data);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }
}
```

## 9. Label Normalization

```typescript
// src/normalize.ts

const COMMON_PREFIXES = ['the', 'a', 'an', 'captain', 'mr', 'mrs', 'dr', 'prof'];

export function normalizeLabel(label: string): string {
  let normalized = label.toLowerCase().trim();

  // Remove common prefixes
  for (const prefix of COMMON_PREFIXES) {
    if (normalized.startsWith(prefix + ' ')) {
      normalized = normalized.slice(prefix.length + 1);
      break;
    }
  }

  // Remove punctuation, collapse whitespace
  normalized = normalized
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}
```

## 10. Rich Relationship Metadata

From entity-model.md:

```typescript
interface RelationshipProperties {
  description: string;        // What this relationship means
  source: {                   // Reference to source text chunk
    pi: string;
    type: string;
    label: string;
  };
  source_text?: string;       // Brief quote from text
  confidence?: number;        // 0.0-1.0
  context?: string;           // Narrative context
}
```

## 11. Error Handling

| Error Type | Handling | Retryable? |
|------------|----------|------------|
| Target not found | Fail immediately | No |
| No text content | Fail with INVALID_INPUT | No |
| Gemini 429 | Retry with backoff | Yes (internal) |
| Gemini 5xx | Retry with backoff | Yes (internal) |
| Gemini timeout | Fail job | Yes (workflow) |
| JSON parse error | Fail with details | No |
| Check-create API error | Retry in batch | Yes (internal) |
| /updates/additive failed | Log warning, continue | N/A (fire-and-forget, API retries internally) |

## 12. Worker Type: Tier 1 (KladosJob)

**Rationale:**
- Gemini (~60s) is subrequest time, not CPU
- Check-create calls are subrequests
- /updates/additive is fire-and-forget (202 immediate)
- Total CPU: parsing, building requests - minimal
- KladosJob handles lifecycle nicely

**If issues arise:**
- If check-create phase exceeds limits, consider Tier 2 with DO state

## 13. Environment Variables

```
GEMINI_API_KEY              # For LLM calls
```

Note: No custom utility URL needed - we use Arke's built-in `/updates/additive` endpoint.

## 14. Testing Strategy

```typescript
describe('kg-extractor', () => {
  it('should extract entities and fire updates', async () => {
    // Create test text chunk
    const textChunk = await createEntity({
      type: 'text_chunk',
      collection: targetCollection.id,
      properties: {
        label: 'Test Chapter',
        content: MOBY_DICK_EXCERPT,
      },
    });

    // Invoke extraction
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: textChunk.id,
      targetCollection: targetCollection.id,
    });

    // Wait for completion
    const tree = await waitForWorkflowTree(result.job_collection, {
      timeout: 180000,
    });

    expect(tree.isComplete).toBe(true);

    // Verify entities were created
    const entities = await listCollectionEntities(targetCollection.id);
    expect(entities.filter(e => e.type === 'person').length).toBeGreaterThan(0);

    // Note: Updates are async, may need to wait/poll for relationship verification
  });
});
```

## 15. Open Questions

1. **Content source**: `properties.content` vs content endpoint?
   - **Decision**: Support both, prefer properties.content

2. **Max text size**:
   - **Decision**: Warn if > 100KB, error if > 500KB

3. **Empty extraction**: What if LLM returns no operations?
   - **Decision**: Log warning, return empty array, continue

4. ~~**Utility failure**: What if POST to utility fails?~~
   - **No longer relevant** - `/updates/additive` handles retries internally

## 16. Reference Files

- `klados-templates/klados-worker-template/src/job.ts` - KladosJob pattern
- `arke-kladoi/knowledge-graph/extraction-test/test-extraction.ts` - Gemini integration
- `arke-kladoi/knowledge-graph/entity-model.md` - Relationship metadata
- `arke-kladoi/knowledge-graph/extraction-algorithm.md` - Processing pipeline
- `arke-kladoi/knowledge-graph/kg-extraction-harness/src/normalize.ts` - Normalization

## 17. Removed: Entity Update Utility

~~Originally planned a custom utility at `utils/entity-update-utility/`~~

**No longer needed!** Arke's `POST /updates/additive` provides:
- Fire-and-forget (202 Accepted)
- Internal CAS retry with exponential backoff
- Deep merge for properties
- Upsert for relationships
- Up to 1,000 updates per batch
- Per-actor versioning for audit trails

This simplifies the architecture significantly - one less service to deploy and maintain.
