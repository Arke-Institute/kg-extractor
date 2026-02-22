# Draft: Claude Skill Klados

## Executive Summary

**Goal:** Build a klados action that Claude (the AI assistant) can invoke as a "skill" to perform operations on the Arke network.

**Key Finding:** No existing Claude skill klados exists. The kg-extractor provides the closest reference pattern for LLM integration, but operates in reverse (klados calls LLM, not LLM calls klados).

---

## What We Have

### Templates Available

| Template | Use Case | Path |
|----------|----------|------|
| Tier 1 (Worker) | Simple tasks < 30s | `klados-templates/klados-worker-template/` |
| Tier 2 (DO) | Long-running tasks | `klados-templates/klados-do-template/` |
| Workflow | Chaining kladoi | `klados-templates/rhiza-workflow-template/` |

### Existing LLM Example

**kg-extractor** (`arke-kladoi/knowledge-graph/kg-extractor/`)
- Tier 2 DO architecture
- Calls Gemini API for extraction
- Pattern: Entity → LLM → Create entities → Fire updates

### Testing Infrastructure

**@arke-institute/klados-testing** provides:
- `configureTestClient()` - Setup
- `createCollection()` / `createEntity()` - Test fixtures
- `invokeKlados()` - Invoke workers
- `waitForWorkflowTree()` - Wait for completion (tree traversal, no indexing lag)

### Registration Process

```bash
# Register to test network
ARKE_USER_KEY=uk_... npm run register

# Register to main network
ARKE_USER_KEY=uk_... npm run register:prod
```

Creates klados entity on Arke, saves state to `.klados-state.json`.

---

## Design Question: What is a "Claude Skill"?

Two possible interpretations:

### Option A: Claude Invokes Klados (MCP Tool)

Claude Code / Claude Desktop has MCP (Model Context Protocol) integration. A Claude skill could be an MCP server that wraps klados invocation:

```
Claude → MCP Tool → Klados Invoke API → Worker → Arke Network
```

**Components needed:**
1. MCP server (TypeScript/Python) that exposes klados operations as tools
2. Klados worker(s) for specific operations (create entity, search, etc.)
3. Permission grants for Claude's user key

**Pros:** Native Claude integration, conversational UX
**Cons:** Requires MCP server, authentication flow

### Option B: Klados Calls Claude API

A klados worker that uses Claude API for intelligent processing (similar to kg-extractor using Gemini):

```
Arke Entity → Klados Worker → Claude API → Process → Create Results
```

**Components needed:**
1. Klados worker with Claude API integration
2. Prompts for specific tasks
3. Output parsing and entity creation

**Pros:** Uses existing patterns (kg-extractor template)
**Cons:** Not a "skill" in Claude's sense

### Option C: Hybrid - Claude Skill for Workflow Orchestration

Claude invokes rhiza workflows via MCP, orchestrating multiple kladoi:

```
Claude → MCP → Invoke Rhiza Workflow → Multiple Kladoi → Complex Result
```

**Components needed:**
1. MCP server exposing rhiza workflows as skills
2. Workflow definitions for common operations
3. Result formatting for Claude consumption

---

## Recommended Approach: MCP Tool for Klados/Rhiza

Build an MCP server that exposes Arke/klados operations to Claude:

### Phase 1: Core MCP Server

```typescript
// Tools to expose
const tools = [
  {
    name: "arke_invoke_klados",
    description: "Invoke a klados action on an entity",
    parameters: {
      klados_id: "string",
      entity_id: "string",
      collection_id: "string"
    }
  },
  {
    name: "arke_create_entity",
    description: "Create an entity in a collection",
    parameters: {
      collection_id: "string",
      type: "string",
      label: "string",
      properties: "object"
    }
  },
  {
    name: "arke_search",
    description: "Search for entities",
    parameters: {
      collection_id: "string",
      query: "string"
    }
  },
  {
    name: "arke_invoke_workflow",
    description: "Start a rhiza workflow",
    parameters: {
      rhiza_id: "string",
      target_entity: "string"
    }
  }
]
```

### Phase 2: Specialized Kladoi

Build purpose-specific kladoi that Claude can invoke:

1. **summarize-klados** - Summarize entity content
2. **extract-klados** - Extract structured data (reuse kg-extractor patterns)
3. **transform-klados** - Transform entity properties
4. **query-klados** - Execute complex queries

### Phase 3: Workflow Templates

Pre-built workflows Claude can trigger:

1. **research-workflow** - Gather + analyze + summarize
2. **extraction-pipeline** - Chunk + extract + merge
3. **review-workflow** - Analyze + critique + suggest

---

## Technical Architecture

### MCP Server Structure

```
claude-arke-mcp/
├── src/
│   ├── index.ts          # MCP server entry
│   ├── tools/
│   │   ├── invoke.ts     # Klados invocation
│   │   ├── entities.ts   # Entity CRUD
│   │   ├── search.ts     # Search operations
│   │   └── workflows.ts  # Rhiza workflows
│   ├── auth/
│   │   └── keys.ts       # API key management
│   └── types.ts
├── package.json
└── README.md
```

### Authentication Flow

```
1. User configures MCP with their ARKE_USER_KEY
2. MCP server uses key for all API calls
3. Klados workers use ARKE_AGENT_KEY (ak_...)
4. Permission grants connect user → klados → collections
```

### Klados Worker Structure (Per Operation)

```
klados-summarize/
├── src/
│   ├── index.ts          # Hono router
│   ├── job.ts            # Summarization logic
│   └── types.ts
├── agent.json            # Metadata
├── scripts/register.ts
├── test/worker.test.ts
├── wrangler.jsonc
└── package.json
```

---

## Implementation Steps

### Step 1: Create MCP Server

1. Set up TypeScript MCP server project
2. Implement basic tools (invoke, create, search)
3. Add authentication configuration
4. Test with Claude Desktop

### Step 2: Build Foundation Kladoi

1. Copy from klados-worker-template
2. Implement simple operations (summarize, transform)
3. Register on test network
4. E2E test with klados-testing

### Step 3: Create Workflows

1. Define rhiza workflows for common patterns
2. Register workflows on network
3. Test end-to-end

### Step 4: Integration Testing

1. Test MCP → Klados flow
2. Test MCP → Rhiza workflow flow
3. Verify Claude can use skills naturally

---

## Key Patterns to Follow

### From kg-extractor (LLM Integration)

```typescript
// Retry logic for API calls
export async function callLLM(prompt: string): Promise<Response> {
  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    try {
      const response = await fetch(API_URL, { ... });
      if (response.ok) return response;
      if (response.status === 429) await sleep(backoff(retry));
    } catch (e) {
      if (retry === MAX_RETRIES - 1) throw e;
    }
  }
}
```

### From stamp-worker (Simple Operations)

```typescript
export async function processJob(job: KladosJob): Promise<string[]> {
  const target = await job.fetchTarget();

  // Transform
  const result = transform(target.properties);

  // Create output
  const { data: output } = await job.client.api.POST('/entities', {
    body: {
      type: 'result',
      collection: job.request.target_collection,
      properties: result,
      relationships: [{ predicate: 'derived_from', peer: target.id }]
    }
  });

  return [output.id];
}
```

### From klados-testing (E2E Tests)

```typescript
import { configureTestClient, createCollection, createEntity, invokeKlados, waitForWorkflowTree } from '@arke-institute/klados-testing';

test('skill invocation', async () => {
  configureTestClient({ apiBase, userKey, network: 'test' });

  const collection = await createCollection({ label: 'Test' });
  const entity = await createEntity(collection.id, { content: 'test data' });
  const job = await invokeKlados(KLADOS_ID, entity.id, collection.id, jobCollection.id);

  const tree = await waitForWorkflowTree(jobCollection.id, { timeout: 60000 });
  expect(tree.isComplete).toBe(true);
});
```

---

## Open Questions

1. **MCP vs Direct API:** Should Claude call Arke API directly or go through MCP wrapper?
2. **Skill Discovery:** How does Claude know what kladoi are available?
3. **Permission Model:** How to handle user permissions for Claude's actions?
4. **Result Formatting:** How should klados results be formatted for Claude consumption?
5. **Error Handling:** How should failures be communicated back to Claude?

---

## Existing Documentation

| Topic | Location |
|-------|----------|
| Worker template | `klados-templates/klados-worker-template/README.md` |
| DO template | `klados-templates/klados-do-template/README.md` |
| Rhiza library | `rhiza/README.md`, `rhiza/docs/` |
| Architecture | `docs/architecture.md` |
| Testing | `rhiza/packages/klados-testing/README.md` |
| Examples | `klados-templates/klados-examples/README.md` |

---

## Next Steps

1. **Clarify intent:** Is this MCP-based Claude skill, or klados that uses Claude API?
2. **Choose tier:** Tier 1 (simple) or Tier 2 (complex/long-running)?
3. **Define operations:** What specific skills should be available?
4. **Build prototype:** Start with one simple skill end-to-end
