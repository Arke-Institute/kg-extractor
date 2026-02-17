# Enrich Entity Extraction Quality

## Problem

Extracted knowledge entities are underwhelming:
- Empty descriptions on relationships
- Very few entities have meaningful properties
- No entity-level descriptions explaining what each entity is
- `source_text` inclusion is inconsistent
- `confidence` is always 1.0 (useless noise)
- Surface-level extraction - not capturing richness

## Solution

Restructure the extraction format to produce richer entities with less friction.

### Key Changes

1. **Add `description` to CREATE** (required) - Brief explanation of what the entity is
2. **Add `properties` to CREATE** - Include properties inline (at least 2 per entity)
3. **Drop `confidence` entirely** - Always 1.0, adds no value
4. **Replace `source_text` with quote markers** - `quote_start`/`quote_end` (~4 words each)
5. **Require `description` on relationships** - What the relationship means in context
6. **Deprecate `add_property`** - Still supported but primary path is properties at creation

### New Operation Format

**CREATE (before)**:
```json
{"op": "create", "label": "SEC", "entity_type": "government_agency"}
{"op": "add_property", "entity": "SEC", "key": "full_name", "value": "Securities and Exchange Commission"}
{"op": "add_property", "entity": "SEC", "key": "role", "value": "securities regulator"}
```

**CREATE (after)**:
```json
{
  "op": "create",
  "label": "SEC",
  "entity_type": "government_agency",
  "description": "The primary federal regulatory body overseeing securities markets in the United States",
  "properties": {
    "full_name": "Securities and Exchange Commission",
    "role": "securities regulator",
    "jurisdiction": "United States"
  }
}
```

**ADD_RELATIONSHIP (before)**:
```json
{
  "op": "add_relationship",
  "subject": "SEC",
  "predicate": "regulates",
  "target": "securities markets",
  "source_text": "The SEC oversees securities markets",
  "confidence": 1.0
}
```

**ADD_RELATIONSHIP (after)**:
```json
{
  "op": "add_relationship",
  "subject": "SEC",
  "predicate": "regulates",
  "target": "securities markets",
  "description": "SEC has regulatory authority over all securities trading activities",
  "quote_start": "The SEC oversees",
  "quote_end": "securities markets"
}
```

### Quote Extraction Logic

Post-process to find actual quotes from source text:
1. Search for `quote_start` in source text
2. Search for `quote_end` after that position
3. Extract everything between (inclusive)
4. If not found, drop `source_text` field (description still valuable)

Benefits:
- Exact quote fidelity (no transcription errors)
- Fewer output tokens
- Consistent presence when markers found

---

## Implementation Status: COMPLETE ✅

All phases implemented and tested. Ready for deployment.

---

## Implementation Plan

### Phase 1: Type Updates (`types.ts`) ✅

- [x] Add `description: string` to `CreateOp` (required)
- [x] Add `properties?: Record<string, string>` to `CreateOp`
- [x] Remove `confidence` and `context` from `AddRelationshipOp`
- [x] Remove `source_text` from `AddRelationshipOp`
- [x] Add `quote_start?: string` and `quote_end?: string` to `AddRelationshipOp`
- [x] Change `description` from optional to required on `AddRelationshipOp`

### Phase 2: Prompt Updates (`prompts.ts`) ✅

- [x] Update `SYSTEM_PROMPT` with new operation format
- [x] Show CREATE with inline description + properties
- [x] Show ADD_RELATIONSHIP with required description + quote markers
- [x] Add guideline: "Every entity must have a description and at least 2 properties"
- [x] Remove all confidence guidance
- [x] Add quote marker guidance: "~4 words from start and end of supporting text"
- [x] Note that `add_property` is available but inline properties preferred

### Phase 3: Parser Updates (`parse.ts`) ✅

- [x] Update `isCreateOp` to require `description`
- [x] Update `isCreateOp` to handle optional `properties` object
- [x] Update `isAddRelationshipOp` to require `description`
- [x] Update `isAddRelationshipOp` to handle `quote_start`/`quote_end`
- [x] Remove handling for `confidence`, `context`, `source_text`
- [x] Add warning for entities with < 2 properties

### Phase 4: Quote Extraction (`quotes.ts` - new file) ✅

- [x] Create `extractQuote(text: string, start: string, end: string): string | null`
- [x] Fuzzy matching for quote boundaries (handle whitespace variations)
- [x] Return null if quote not found (graceful degradation)
- [x] Unit tests for quote extraction edge cases

### Phase 5: Job Updates (`job.ts`) ✅

- [x] Update entity creation to use inline `properties` from CreateOp
- [x] Add `description` property from CreateOp to entity properties
- [x] Update relationship building to use `extractQuote()` for `source_text`
- [x] Use relationship `description` field (now required)
- [x] Remove confidence handling

### Phase 6: Testing ✅

- [x] Add tests for quote extraction (10 tests, all passing)
- [x] Type-check passes
- [ ] Run full E2E extraction test after deployment
- [ ] Verify entity richness improved after deployment

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/types.ts` | CreateOp + AddRelationshipOp restructure |
| `src/prompts.ts` | New SYSTEM_PROMPT with examples |
| `src/parse.ts` | Updated type guards + validation |
| `src/quotes.ts` | **New file** - quote extraction utility |
| `src/job.ts` | Use new operation structure |
| `tests/*.test.ts` | Update for new format |

## Risks & Mitigations

**Risk**: LLM doesn't follow new format consistently
**Mitigation**: Graceful degradation - parse what we can, warn on issues

**Risk**: Quote markers not found in text
**Mitigation**: Just drop source_text, description is still valuable

**Risk**: Breaking existing workflows
**Mitigation**: Support old format during transition (detect by presence of fields)

---

# Fix Race Condition with sync_index

## Problem
Two chunks processing "Queequeg" in parallel both create entities because the API index has lag. By the time each does its second check, only its own entity is visible.

## Solution ✅ IMPLEMENTED
Combined approach:
1. `sync_index: true` on entity creation (ensures our entity is indexed before returning)
2. Post-creation delay with jitter (100-200ms) to let concurrent creates finish
3. Retry loop (up to 2 retries) for the second lookup
4. Store normalized labels to ensure lookup consistency

## Results

| Test Run | Duplicates | Notes |
|----------|------------|-------|
| Before fix | 10+ | Consistent duplicates |
| sync_index only | 10 | sync_index alone insufficient |
| + 50ms delay | 4 | Better but not perfect |
| + jitter | 8 | Worse (more random collisions) |
| + normalized labels | 1 | Near-perfect |

**Final result: 1 duplicate out of 500 entities (0.2%)**

## Implementation Details

### Changes Made

1. `src/normalize.ts` - Simplified to not strip prefixes (exact match API requires exact labels)
2. `src/check-create.ts`:
   - Added `sync_index: true` to entity creation
   - Store normalized labels (not original)
   - Added 100-200ms jittered delay after creation
   - Added retry loop (up to 2 retries) for second lookup
   - Return normalized labels in results

### Code Pattern
```typescript
// 1. Normalize label
const normalizedLabel = normalizeLabel(label);

// 2. Check if exists
const existing = await lookupByLabel(client, collection, normalizedLabel, type);
if (existing) return existing;

// 3. Create with normalized label + sync_index
const created = await createEntity(client, collection, type, normalizedLabel);

// 4. Wait for concurrent creates (jittered delay)
await delay(100, 100); // 100-200ms

// 5. Check again with retries
let allMatches = await lookupAllByLabel(client, collection, normalizedLabel, type);
for (let retry = 0; retry < 2 && allMatches.length === 1; retry++) {
  await delay(150, 100);
  allMatches = await lookupAllByLabel(...);
}

// 6. If race detected, keep earliest, delete ours
if (allMatches.length > 1) {
  const winner = allMatches.sort(...)[0];
  if (winner.id !== created.id) {
    await deleteEntity(client, created.id);
    return winner;
  }
}
```

## Trade-offs
- ~300-500ms additional latency per entity creation (worst case)
- Near-perfect deduplication (99.8%)
- Remaining edge case: simultaneous creates within <100ms window

## Remaining Issues (Semantic Duplicates)
The LLM sometimes assigns different types to the same entity across chunks:
- "nantucket" as place/city/island
- "harpooneer" as character/role/person

This is a prompt/extraction issue, not a deduplication issue.
