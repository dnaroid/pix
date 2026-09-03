import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";

export interface ElicitationField {
  key: string;
  label: string;
  description?: string;
  type: "string" | "select" | "boolean";
  options: string[];
  value: string | boolean;
}

export function parseElicitation(request: CreateElicitationRequest): ElicitationField | null {
  const raw = request as unknown as Record<string, unknown>;
  if (raw.mode !== "form" || !isRecord(raw.requestedSchema)) return null;
  const properties = raw.requestedSchema.properties;
  if (!isRecord(properties)) return null;
  const entries = Object.entries(properties);
  if (entries.length !== 1) return null;
  const [key, property] = entries[0]!;
  if (!isRecord(property)) return null;
  const label = typeof property.title === "string" ? property.title : key;
  const description = typeof property.description === "string" ? property.description : undefined;
  if (property.type === "boolean") {
    return {
      key,
      label,
      ...(description ? { description } : {}),
      type: "boolean",
      options: [],
      value: Boolean(property.default),
    };
  }
  if (property.type !== "string") return null;
  const options = Array.isArray(property.enum)
    ? property.enum.filter((value): value is string => typeof value === "string")
    : [];
  return {
    key,
    label,
    ...(description ? { description } : {}),
    type: options.length ? "select" : "string",
    options,
    value: typeof property.default === "string" ? property.default : (options[0] ?? ""),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
