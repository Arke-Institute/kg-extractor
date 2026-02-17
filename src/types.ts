/**
 * Type definitions for the KG Extractor v2 worker (Durable Object based)
 */

/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /** Klados agent ID (registered in Arke) */
  AGENT_ID: string;

  /** Agent version for logging */
  AGENT_VERSION: string;

  /** Arke agent API key (secret) */
  ARKE_AGENT_KEY: string;

  /** Gemini API key for LLM calls (secret) */
  GEMINI_API_KEY: string;

  /** Verification token for endpoint verification (set during registration) */
  VERIFICATION_TOKEN?: string;

  /** Agent ID for verification (used before AGENT_ID is configured) */
  ARKE_VERIFY_AGENT_ID?: string;

  /** Durable Object binding for job processing */
  KLADOS_JOB: DurableObjectNamespace;
}

/**
 * Properties expected on target entities (text chunks)
 */
export interface TargetProperties {
  label?: string;
  text?: string;
  content?: string; // Deprecated - use text instead
  [key: string]: unknown;
}

/**
 * LLM operation types
 */
export interface CreateOp {
  op: 'create';
  label: string;
  entity_type: string;
}

export interface AddPropertyOp {
  op: 'add_property';
  entity: string;
  key: string;
  value: string;
}

export interface AddRelationshipOp {
  op: 'add_relationship';
  subject: string;
  predicate: string;
  target: string;
  description?: string;
  source_text?: string;
  confidence?: number;
  context?: string;
}

export type Operation = CreateOp | AddPropertyOp | AddRelationshipOp;

/**
 * Parsed operations grouped by type
 */
export interface ParsedOperations {
  creates: CreateOp[];
  properties: AddPropertyOp[];
  relationships: AddRelationshipOp[];
}

/**
 * Gemini API response structure
 */
export interface GeminiResponse {
  content: string;
  tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

/**
 * Result of check-create operation
 */
export interface CheckCreateResult {
  entityId: string;
  isNew: boolean;
  label: string;
  type: string;
}

/**
 * Source reference for relationship provenance
 */
export interface SourceRef {
  id: string;
  type: string;
  label: string;
}

/**
 * Peer preview from expand=relationships:preview
 */
export interface PeerPreview {
  id: string;
  type: string;
  label: string;
  description_preview?: string;
  text_preview?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Relationship with optional peer preview
 */
export interface RelationshipWithPreview {
  predicate: string;
  peer: string;
  direction: 'outgoing' | 'incoming';
  peer_label?: string;
  peer_type?: string;
  peer_preview?: PeerPreview;
  properties?: Record<string, unknown>;
}

/**
 * Entity context passed to the LLM prompt (everything except raw text)
 */
export interface EntityContext {
  id: string;
  type: string;
  label: string;
  description?: string;
  properties: Record<string, unknown>;
  relationships: RelationshipWithPreview[];
}

/**
 * Update to send to /updates/additive
 */
export interface AdditiveUpdate {
  entity_id: string;
  properties?: Record<string, unknown>;
  relationships_add?: Array<{
    predicate: string;
    peer: string;
    direction?: 'outgoing' | 'incoming';
    peer_label?: string;
    peer_type?: string;
    properties?: Record<string, unknown>;
  }>;
}
