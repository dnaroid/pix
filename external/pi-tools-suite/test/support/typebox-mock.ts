export function createTypeboxMock(overrides: Record<string, unknown> = {}) {
	return {
		Type: {
			Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
			Optional: (schema: any) => ({ kind: "optional", schema }),
			String: (options?: any) => ({ kind: "string", options }),
			Array: (items: any, options?: any) => ({ kind: "array", items, options }),
			Number: (options?: any) => ({ kind: "number", options }),
			Boolean: (options?: any) => ({ kind: "boolean", options }),
			Record: (key: any, value: any, options?: any) => ({ kind: "record", key, value, options }),
			Unknown: (options?: any) => ({ kind: "unknown", options }),
			Union: (items: any, options?: any) => ({ kind: "union", items, options }),
			Literal: (value: any, options?: any) => ({ kind: "literal", value, options }),
			...overrides,
		},
	};
}
