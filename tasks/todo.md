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
