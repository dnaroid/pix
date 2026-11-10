import { Type, type TUnsafe } from "typebox";

/** Provider-friendly string enums with TypeBox inference for direct SDK consumers. */
export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
