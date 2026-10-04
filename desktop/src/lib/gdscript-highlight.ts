import { parse, render, type ParseOptions } from "sugar-high/core";

const config: ParseOptions = {
  keywords: new Set([
    "and", "as", "assert", "await", "break", "breakpoint", "class", "class_name",
    "const", "continue", "elif", "else", "enum", "extends", "false", "for", "func",
    "if", "in", "is", "match", "not", "null", "or", "pass", "preload", "return",
    "self", "signal", "static", "super", "true", "var", "while",
  ]),
  typeKeywords: new Set([
    "void", "bool", "int", "float", "String", "StringName", "NodePath", "Vector2",
    "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Rect2", "Rect2i",
    "Transform2D", "Transform3D", "Plane", "Quaternion", "AABB", "Basis", "Projection",
    "Color", "Dictionary", "Array", "Callable", "Signal", "Object", "Node", "Variant",
  ]),
  onCommentStart: (current) => current === "#" ? 1 : 0,
  onCommentEnd: (_previous, current) => current === "\n" ? 1 : 0,
  jsx: false,
  regex: false,
  templateStrings: false,
};

/** Reuse the shared escaped markup and theme roles with GDScript's own vocabulary. */
export function highlightGDScript(code: string): string {
  return render(parse(code, config));
}
