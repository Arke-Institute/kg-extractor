# kg-extractor

A klados worker that extracts knowledge graph entities and relationships from text using Gemini AI.

## Overview

This worker processes text content from Arke entities and extracts:
- **Entities** - People, places, organizations, concepts, etc.
- **Relationships** - Connections between entities with predicates and context
- **Properties** - Attributes of extracted entities

Uses a check-create-check-delete pattern for entity deduplication and fire-and-forget updates via `/updates/additive` for efficient batch processing.

## Setup

```bash
npm install
```

### Environment Variables

Create `.dev.vars` for local development:
```
GEMINI_API_KEY=your_gemini_api_key
ARKE_AGENT_KEY=ak_...  # Created during registration
```

## Development

```bash
npm run dev        # Start local dev server
npm run type-check # TypeScript validation
npm test           # Run E2E tests
```

## Registration

Register to test network:
```bash
ARKE_USER_KEY=uk_... npm run register
```

Register to production:
```bash
ARKE_USER_KEY=uk_... npm run register:prod
```

## Deployment

```bash
npm run deploy
```

Set secrets in Cloudflare:
```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put ARKE_AGENT_KEY
```

## Usage

Invoke via Arke API:
```bash
POST /kladoi/{klados_id}/invoke
{
  "target_entity": "entity_with_text_content",
  "target_collection": "collection_for_extracted_entities",
  "confirm": true
}
```

The worker will:
1. Fetch text content from the target entity
2. Call Gemini to extract entities and relationships
3. Check-create entities in the target collection (deduplication)
4. Fire updates to add properties and relationships

## Architecture

- **Tier 1 worker** - Uses `KladosJob` from `@arke-institute/rhiza`
- **Fire-and-forget updates** - Non-blocking relationship creation
- **Bounded concurrency** - 20 parallel entity creation requests

## License

MIT
