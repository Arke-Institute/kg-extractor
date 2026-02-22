# Claude Code Skill: Klados Developer

## Overview

A Claude Code skill that helps developers create, test, and deploy klados workers and rhiza workflows on the Arke network.

---

## Skill Structure

```
.claude/skills/klados-dev/
├── SKILL.md                    # Main skill instructions
├── references/
│   ├── tier1-patterns.md       # Tier 1 worker patterns
│   ├── tier2-patterns.md       # Tier 2 DO patterns
│   ├── rhiza-workflows.md      # Workflow definitions
│   ├── testing-guide.md        # klados-testing usage
│   ├── registration.md         # Registration process
│   ├── api-patterns.md         # Arke API patterns
│   └── limits.md               # Cloudflare limits
├── templates/
│   ├── tier1/                  # Tier 1 worker template files
│   │   ├── agent.json
│   │   ├── index.ts
│   │   ├── job.ts
│   │   ├── types.ts
│   │   ├── wrangler.jsonc
│   │   └── package.json
│   ├── tier2/                  # Tier 2 DO template files
│   │   ├── agent.json
│   │   ├── index.ts
│   │   ├── job-do.ts
│   │   ├── job.ts
│   │   ├── types.ts
│   │   ├── wrangler.jsonc
│   │   └── package.json
│   └── workflow/               # Rhiza workflow template
│       └── workflow.json
└── examples/
    ├── stamp-worker/           # Simple example
    ├── kg-extractor/           # LLM integration example
    └── scatter-gather/         # Batch processing example
```

---

## SKILL.md Design

```yaml
---
name: klados-dev
description: Create, test, and deploy klados workers and rhiza workflows for the Arke network
tools: Read, Glob, Grep, Bash, Edit, Write, TodoWrite
model: sonnet
---

# Klados Developer Skill

You help developers build klados workers and rhiza workflows for the Arke network.

## Capabilities

1. **Scaffold** - Create new klados workers from templates (Tier 1 or Tier 2)
2. **Implement** - Write job processing logic with proper patterns
3. **Test** - Set up and run E2E tests with klados-testing
4. **Register** - Register workers to test/main network
5. **Workflow** - Create rhiza workflow definitions
6. **Debug** - Troubleshoot klados execution issues

## Context

Current directory: !`pwd`
Package.json exists: !`test -f package.json && echo "yes" || echo "no"`
Wrangler config: !`test -f wrangler.jsonc && echo "exists" || echo "missing"`
Agent.json: !`test -f agent.json && cat agent.json || echo "missing"`

## Workflow

### Phase 1: Understand Intent

Ask the user:
- What should this klados do? (summarize, extract, transform, etc.)
- What entity types does it accept?
- What does it produce?
- Expected processing time? (< 30s = Tier 1, longer = Tier 2)
- Does it call external APIs? (LLM, etc.)

### Phase 2: Choose Architecture

Based on requirements:
- **Tier 1** (KladosJob + waitUntil): Simple processing < 30s, < 1000 sub-requests
- **Tier 2** (Durable Object): Long-running, batch operations, checkpointing needed

### Phase 3: Scaffold

Create project structure:
1. Copy appropriate template
2. Update `agent.json` with metadata
3. Update `wrangler.jsonc` with worker name
4. Update `package.json` with dependencies

### Phase 4: Implement

Write the core logic in `src/job.ts`:
1. Fetch target entity
2. Validate input
3. Process (call APIs, transform data)
4. Create output entities (in target_collection, NOT job_collection!)
5. Return output IDs for handoff

### Phase 5: Test

Set up testing:
1. Create test file using klados-testing
2. Use `waitForWorkflowTree()` (not `waitForWorkflowCompletion`)
3. Run tests: `npm test`

### Phase 6: Register & Deploy

1. Set environment: `ARKE_USER_KEY=uk_...`
2. Register: `npm run register` (test) or `npm run register:prod` (main)
3. Deploy: `npm run deploy`
4. Verify: Check logs with `wrangler tail`

## Critical Patterns

### ALWAYS Use Target Collection for Output
```typescript
// WRONG - job_collection is only for logs
collection: job.request.job_collection

// CORRECT - target_collection is where work happens
collection: job.request.target_collection
```

### CAS-Safe Updates
```typescript
const tip = await job.client.api.GET('/entities/{id}/tip', {...});
await job.client.api.PUT('/entities/{id}', {
  body: { expect_tip: tip.cid, ...updates }
});
```

### Fire-and-Forget for Non-Critical Updates
```typescript
// Don't await - let it fire in background
fireUpdates(client, updates);  // No await
```

### Tree Traversal for Test Completion
```typescript
// CORRECT - no indexing lag
const tree = await waitForWorkflowTree(jobCollectionId, { timeout: 120000 });

// WRONG - has indexing lag issues
const result = await waitForWorkflowCompletion(jobCollectionId, {...});
```

## References

See `references/` directory for detailed patterns:
- [Tier 1 Patterns](references/tier1-patterns.md)
- [Tier 2 Patterns](references/tier2-patterns.md)
- [Rhiza Workflows](references/rhiza-workflows.md)
- [Testing Guide](references/testing-guide.md)
- [Registration](references/registration.md)
- [API Patterns](references/api-patterns.md)
- [Cloudflare Limits](references/limits.md)

## Commands

- `/klados-dev new <name>` - Scaffold new klados worker
- `/klados-dev workflow <name>` - Create rhiza workflow
- `/klados-dev test` - Run tests
- `/klados-dev register` - Register to test network
- `/klados-dev deploy` - Deploy to Cloudflare
```

---

## Reference Files Content

### references/tier1-patterns.md

```markdown
# Tier 1 Worker Patterns

## When to Use
- Processing < 30 seconds
- < 1000 sub-requests
- No checkpointing needed
- Simple input → output transformation

## Structure

### index.ts
```typescript
import { Hono } from 'hono';
import { KladosJob } from '@arke-institute/rhiza';
import { processJob } from './job';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/.well-known/arke-verification', (c) => {
  return c.text(c.env.AGENT_ID);
});

app.post('/process', async (c) => {
  const req = await c.req.json();

  const job = KladosJob.accept(req, {
    agentId: c.env.AGENT_ID,
    agentVersion: c.env.AGENT_VERSION,
    authToken: c.env.ARKE_AGENT_KEY,
  });

  c.executionCtx.waitUntil(
    job.run(async () => {
      return await processJob(job);
    })
  );

  return c.json(job.acceptResponse);
});

export default app;
```

### job.ts (5-Step Pattern)
```typescript
import { KladosJob } from '@arke-institute/rhiza';

export async function processJob(job: KladosJob): Promise<string[]> {
  // Step 1: Fetch target
  const target = await job.fetchTarget();
  job.log.info(`Processing: ${target.properties.label}`);

  // Step 2: Validate
  if (!target.properties.content) {
    throw new Error('Content required');
  }

  // Step 3: Process
  const result = await transform(target.properties.content);

  // Step 4: Create output (USE target_collection!)
  const { data: output } = await job.client.api.POST('/entities', {
    body: {
      type: 'result',
      collection: job.request.target_collection,
      properties: { result },
      relationships: [{
        predicate: 'derived_from',
        peer: target.id,
      }]
    }
  });

  job.log.success(`Created output: ${output.id}`);

  // Step 5: Return outputs for handoff
  return [output.id];
}
```
```

### references/tier2-patterns.md

```markdown
# Tier 2 Durable Object Patterns

## When to Use
- Processing > 30 seconds
- > 1000 sub-requests needed
- Batch scatter/gather operations
- Checkpointing required
- External API polling (Lambda, etc.)

## Structure

### index.ts (Dispatcher)
```typescript
app.post('/process', async (c) => {
  const req = await c.req.json();

  // Get DO keyed by job_id
  const doId = c.env.KLADOS_JOB.idFromName(req.job_id);
  const doStub = c.env.KLADOS_JOB.get(doId);

  // Start job in DO
  const response = await doStub.fetch(new Request('https://do/start', {
    method: 'POST',
    body: JSON.stringify({ request: req, config: {...} })
  }));

  return c.json(await response.json());
});
```

### job-do.ts (Durable Object)
```typescript
export class KladosJobDO implements DurableObject {
  private sql: SqlStorage;

  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS job_state (...)`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/start') {
      return this.handleStart(request);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleStart(request: Request): Promise<Response> {
    const { request: jobReq, config } = await request.json();

    // Store state
    this.sql.exec('INSERT INTO job_state ...', jobReq);

    // Schedule alarm (100ms delay)
    await this.state.storage.setAlarm(Date.now() + 100);

    return Response.json({ accepted: true, job_id: jobReq.job_id });
  }

  async alarm(): Promise<void> {
    // No 30s limit here!
    await this.runJob();
  }
}
```

### wrangler.jsonc (DO Config)
```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "KLADOS_JOB", "class_name": "KladosJobDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["KladosJobDO"] }
  ]
}
```
```

### references/testing-guide.md

```markdown
# Testing with klados-testing

## Setup

```typescript
import {
  configureTestClient,
  createCollection,
  createEntity,
  invokeKlados,
  waitForWorkflowTree,
} from '@arke-institute/klados-testing';

// Configure once
configureTestClient({
  apiBase: 'https://arke-v1.arke.institute',
  userKey: process.env.ARKE_USER_KEY!,
  network: 'test',
});
```

## Basic Test Pattern

```typescript
import { describe, test, expect } from 'vitest';

describe('my-klados', () => {
  test('processes entity', async () => {
    // Create test fixtures
    const collection = await createCollection({ label: 'Test Collection' });
    const jobCollection = await createCollection({ label: 'Job Collection' });
    const entity = await createEntity(collection.id, {
      label: 'Test Entity',
      content: 'test data',
    });

    // Invoke klados
    const job = await invokeKlados(
      KLADOS_ID,
      entity.id,
      collection.id,
      jobCollection.id
    );

    // Wait for completion (USE TREE TRAVERSAL!)
    const tree = await waitForWorkflowTree(jobCollection.id, {
      timeout: 120000,
      pollInterval: 3000,
      onPoll: (t, elapsed) => {
        console.log(`${t.logs.size} logs, complete=${t.isComplete}`);
      },
    });

    // Assertions
    expect(tree.isComplete).toBe(true);

    const logs = Array.from(tree.logs.values());
    const mainLog = logs.find(l => l.klados_id === KLADOS_ID);
    expect(mainLog?.status).toBe('done');
  });
});
```

## CRITICAL: Tree Traversal vs Collection Queries

| Method | Mechanism | Use |
|--------|-----------|-----|
| `waitForWorkflowTree` | Relationship traversal | **PREFERRED** - No indexing lag |
| `waitForWorkflowCompletion` | Collection queries | Legacy - Has indexing lag |

Tree traversal follows `sent_to` outgoing relationships stored on entities - no indexer needed.
```

### references/registration.md

```markdown
# Klados Registration

## Prerequisites

1. Arke user key (`uk_...`)
2. `agent.json` configured
3. Worker deployed to Cloudflare

## Register to Test Network

```bash
ARKE_USER_KEY=uk_... npm run register
```

## Register to Main Network

```bash
ARKE_USER_KEY=uk_... npm run register:prod
```

## What Registration Does

1. Creates/updates klados entity on Arke
2. Verifies endpoint ownership via `/.well-known/arke-verification`
3. Creates klados key (`ak_...`) for worker
4. Updates `wrangler.jsonc` with AGENT_ID
5. Saves state to `.klados-state.json` (test) or `.klados-state.prod.json` (main)

## agent.json Format

```json
{
  "label": "My Klados",
  "description": "What this klados does",
  "endpoint": "https://my-klados.username.workers.dev",
  "actions_required": ["entity:view", "entity:create", "entity:update"],
  "accepts": {
    "types": ["*"],
    "cardinality": "one"
  },
  "produces": {
    "types": ["*"],
    "cardinality": "one"
  }
}
```

## Post-Registration

1. Set secrets: `wrangler secret put ARKE_AGENT_KEY`
2. Deploy: `npm run deploy`
3. Verify: `wrangler tail` (run BEFORE test!)
```

### references/limits.md

```markdown
# Cloudflare Workers Limits

## Tier 1 (waitUntil)

| Resource | Limit |
|----------|-------|
| CPU time | 30 seconds |
| Sub-requests | 1000 per invocation |
| Memory | 128MB |

## Tier 2 (Durable Objects)

| Resource | Limit |
|----------|-------|
| SQL row size | 2MB |
| SQL total storage | 10GB per DO |
| Alarm tick | ~30 seconds |
| Memory | 128MB |

## When to Use Tier 2

- > 50 items in scatter
- > 2000 items in gather
- > 30 second processing time
- > 1000 API calls
- Need checkpointing/resumability
```

---

## Installation Location

The skill should be installed at:
- **Project-level**: `.claude/skills/klados-dev/` (for this workspace)
- **Global**: `~/.claude/skills/klados-dev/` (for all projects)

Or packaged as a plugin:
```
klados-dev-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── klados-dev/
│       ├── SKILL.md
│       └── references/
└── README.md
```

---

## Next Steps

1. **Create skill directory structure**
2. **Write SKILL.md with full workflow**
3. **Extract reference content from existing docs**
4. **Copy template files from klados-templates/**
5. **Test skill with `/klados-dev new test-worker`**
