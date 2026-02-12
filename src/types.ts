/**
 * Type definitions for the KG Extractor worker
 */

/**
 * Environment variables available to the worker
 */
export interface Env {
  AGENT_ID: string;
  AGENT_VERSION: string;
  ARKE_AGENT_KEY: string;
  GEMINI_API_KEY: string;
  VERIFICATION_TOKEN?: string;
  ARKE_VERIFY_AGENT_ID?: string;
}

/**
 * Properties expected on target entities (text chunks)
 */
export interface TargetProperties {
  label?: string;
  content?: string;
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
  pi: string;
  type: string;
  label: string;
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
