import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { MAX_KNOWLEDGE_DOCUMENT_CHARS, type KnowledgeCheckRequest } from "./contract.js";
import { MAX_KNOWLEDGE_REPORT_BYTES, MAX_KNOWLEDGE_STAMP_BYTES, stripKnowledgeCheckStamp } from "./stamp.js";

export function parseKnowledgeCheckRequest(value: unknown): KnowledgeCheckRequest {
  const invalid = (): never => { throw new RequestError(-32602, "Invalid Wiki contradiction-check request"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const request = value as Record<string, unknown>;
  if (typeof request.cwd !== "string" || !isAbsolute(request.cwd) || request.cwd.length > 8192 || request.cwd.includes("\0")
    || typeof request.path !== "string" || !request.path || request.path.length > 1024
    || request.path.startsWith("/") || request.path.startsWith("~") || /[\\\u0000-\u001f\u007f:]/u.test(request.path)
    || request.path.split("/").some(part => !part || part === "." || part === "..")
    || !/\.(md|markdown)$/iu.test(request.path) || typeof request.content !== "string"
    || request.content.length > MAX_KNOWLEDGE_DOCUMENT_CHARS + MAX_KNOWLEDGE_STAMP_BYTES + MAX_KNOWLEDGE_REPORT_BYTES
    || stripKnowledgeCheckStamp(request.content).length > MAX_KNOWLEDGE_DOCUMENT_CHARS
    || request.content.includes("\0")) return invalid();
  if (request.expectedContent !== undefined && (typeof request.expectedContent !== "string"
    || request.expectedContent.length > MAX_KNOWLEDGE_DOCUMENT_CHARS + MAX_KNOWLEDGE_STAMP_BYTES + MAX_KNOWLEDGE_REPORT_BYTES
    || request.expectedContent.includes("\0"))) return invalid();
  return { cwd: request.cwd, path: request.path, content: request.content,
    ...(typeof request.expectedContent === "string" ? { expectedContent: request.expectedContent } : {}) };
}
