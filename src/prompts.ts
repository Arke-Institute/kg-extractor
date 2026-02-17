/**
 * Extraction prompts for Gemini
 */

import type { EntityContext } from './types';

/**
 * System prompt that instructs the LLM on extraction format
 */
export const SYSTEM_PROMPT = `You are an entity extractor for knowledge graphs. Your job is to BUILD NEW knowledge graph entities from rich textual content.

CRITICAL DISTINCTION:
- You will receive CONTEXT about the source entity (what it is, what it's part of). This helps you understand the text but is NOT for extraction.
- You will receive TEXT TO ANALYZE. Extract significant entities and relationships ONLY from this text.
- Do NOT recreate or reference the existing graph structure shown in the context. Build NEW knowledge from the text.

IMPORTANT: You are processing ONE CHUNK of a larger document. Focus on entities likely to be referenced in other parts of the document.

EXTRACT:
- Named entities (people, organizations, places, products)
- Key concepts or terms (especially if defined or explained in the text)
- Significant objects, systems, or artifacts
- Events or actions with consequences
- Document structure (chapters, sections, articles, clauses)

SIGNALS OF SIGNIFICANCE:
- Has a proper name or specific identifier
- Is defined, explained, or described in detail
- Is the subject or object of multiple statements
- Would appear in a summary of this text

SKIP:
- Generic references ("the user", "this section", "the system")
- Incidental mentions or passing references
- Common descriptive terms not central to the content
- Temporal markers ("recently", "in 2020") unless the date itself is significant

OUTPUT FORMAT: JSON with "operations" array.

OPERATION TYPES:

1. CREATE - Declare an entity with description and properties
   {
     "op": "create",
     "label": "Captain Ahab",
     "entity_type": "person",
     "description": "The monomaniacal captain of the Pequod, consumed by his obsessive quest to kill Moby Dick",
     "properties": {
       "title": "Captain",
       "physical_trait": "ivory leg replacing one lost to Moby Dick",
       "origin": "Nantucket"
     }
   }

2. ADD_RELATIONSHIP - Link entities with description and quote markers
   {
     "op": "add_relationship",
     "subject": "Captain Ahab",
     "predicate": "commands",
     "target": "Pequod",
     "description": "Ahab serves as the authoritative captain of the whaling vessel Pequod",
     "quote_start": "Ahab stood upon",
     "quote_end": "his quarter-deck"
   }

REQUIREMENTS:
- Every CREATE must include:
  - description: 1-2 sentences explaining what this entity is
  - properties: at least 2 properties capturing key attributes
- Every ADD_RELATIONSHIP must include:
  - description: what this relationship means in context (not just restating the predicate)
  - quote_start: first ~4 words of the supporting text
  - quote_end: last ~4 words of the supporting text

GUIDELINES:
- Create an entity BEFORE referencing it in relationships
- Use consistent labels for the same entity throughout
- Use descriptive entity_type (e.g., "whaling_ship" not just "ship")
- Relationship descriptions should add context beyond the predicate name
- Quote markers help locate the source - be precise with the boundary words

TARGET: ~10-20 entities per chunk. Quality over quantity.`;

/**
 * Build context section from entity metadata and relationships
 */
function buildContextSection(ctx: EntityContext): string {
  const lines: string[] = [];

  lines.push(`Entity ID: ${ctx.id}`);
  lines.push(`Type: ${ctx.type}`);
  lines.push(`Label: ${ctx.label}`);

  if (ctx.description) {
    lines.push(`Description: ${ctx.description}`);
  }

  // Add other meaningful properties (excluding text/content which is shown separately)
  const skipProps = new Set(['label', 'text', 'content', 'description']);
  const otherProps = Object.entries(ctx.properties).filter(
    ([key, value]) => !skipProps.has(key) && value !== undefined && value !== null && value !== ''
  );

  if (otherProps.length > 0) {
    lines.push('');
    lines.push('Properties:');
    for (const [key, value] of otherProps) {
      const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      // Truncate long values
      const truncated = displayValue.length > 200 ? displayValue.slice(0, 200) + '...' : displayValue;
      lines.push(`  ${key}: ${truncated}`);
    }
  }

  // Show relationships with previews
  if (ctx.relationships.length > 0) {
    lines.push('');
    lines.push('Relationships (what this entity is connected to):');
    for (const rel of ctx.relationships) {
      const peerLabel = rel.peer_preview?.label || rel.peer_label || rel.peer;
      const peerType = rel.peer_preview?.type || rel.peer_type || 'unknown';
      lines.push(`  - ${rel.predicate} → "${peerLabel}" (${peerType})`);

      // Add description preview if available
      if (rel.peer_preview?.description_preview) {
        lines.push(`    "${rel.peer_preview.description_preview}"`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Build the user prompt with context and text to extract from
 */
export function buildUserPrompt(text: string, entityContext: EntityContext): string {
  const contextSection = buildContextSection(entityContext);

  return `## CONTEXT (for understanding only - do NOT extract from this)
The following metadata describes what this text IS and what it's PART OF.
Use this context to better understand the text, but extract entities only from the TEXT below.

${contextSection}

---

## TEXT TO ANALYZE (extract knowledge from this)
The following is the primary content. Extract significant entities and relationships from THIS text.

${text}

---

Output only the JSON object with operations array.`;
}
