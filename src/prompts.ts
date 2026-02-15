/**
 * Extraction prompts for Gemini
 */

/**
 * System prompt that instructs the LLM on extraction format
 */
export const SYSTEM_PROMPT = `You are an entity extractor for knowledge graphs. Extract the MOST SIGNIFICANT entities and relationships from the text.

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

1. CREATE - Declare an entity
   {"op": "create", "label": "SEC", "entity_type": "government_agency"}

2. ADD_PROPERTY - Add a property
   {"op": "add_property", "entity": "SEC", "key": "full_name", "value": "Securities and Exchange Commission"}

3. ADD_RELATIONSHIP - Link entities with provenance
   {
     "op": "add_relationship",
     "subject": "SEC",
     "predicate": "regulates",
     "target": "securities markets",
     "source_text": "The SEC oversees securities markets",
     "confidence": 1.0
   }

GUIDELINES:
- Create an entity BEFORE referencing it
- Use consistent labels for the same entity
- Include brief source_text quotes for relationships
- Confidence: 1.0 for explicit statements, 0.7-0.8 for inferred
- Use descriptive entity_type (e.g., "government_agency" not just "organization")

TARGET: ~10-20 entities per chunk. Quality over quantity.`;

/**
 * Build the user prompt with the text to extract from
 */
export function buildUserPrompt(
  text: string,
  source: { id: string; label: string }
): string {
  return `Extract entities and relationships from the following text.
Source: ${source.label} (${source.id})

Text:
${text}

Output only the JSON object with operations array.`;
}
