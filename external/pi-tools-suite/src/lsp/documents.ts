import { filePathToUri } from "./_shared/paths";
import type { OpenDocument } from "./types";

export class DocumentStore {
  private readonly documents = new Map<string, OpenDocument>();

  get(file: string): OpenDocument | undefined {
    return this.documents.get(file);
  }

  open(file: string, languageId: string, text: string): OpenDocument {
    const doc: OpenDocument = { file, uri: filePathToUri(file), languageId, version: 1, text };
    this.documents.set(file, doc);
    return doc;
  }

  change(file: string, text: string): OpenDocument {
    const existing = this.documents.get(file);
    if (!existing) throw new Error(`document not opened: ${file}`);
    const updated: OpenDocument = { ...existing, version: existing.version + 1, text };
    this.documents.set(file, updated);
    return updated;
  }
}
