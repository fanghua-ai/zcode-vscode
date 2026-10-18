import { draftImages, type DraftImage } from "./attachmentTypes";
import type { ContextChip, SessionReference } from "./promptContext";

export interface ComposerDraft {
  text: string;
  chips: ContextChip[];
  sessionRefs?: SessionReference[];
  images?: DraftImage[];
}

function copy(draft: ComposerDraft): ComposerDraft {
  return {
    text: draft.text,
    chips: draft.chips.map(chip => ({ ...chip })),
    ...(draft.sessionRefs?.length ? { sessionRefs: draft.sessionRefs.map(reference => ({ ...reference })) } : {}),
    ...(draft.images?.length ? {images:draft.images.map(image=>({...image}))} : {}),
  };
}

/** Persist only user input and explicit references, never generated content. */
export class ComposerDrafts {
  private drafts = new Map<string, ComposerDraft>();

  constructor(saved: unknown) {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [id, value] of Object.entries(saved)) {
      if (!value || typeof value !== "object") continue;
      const draft = value as Partial<ComposerDraft>;
      if (typeof draft.text !== "string" || !Array.isArray(draft.chips)) continue;
      const chips = draft.chips.filter((chip): chip is ContextChip =>
        !!chip && typeof chip === "object" && typeof chip.path === "string" && typeof chip.relPath === "string"
      ).map(chip => ({ ...chip, implicit: false }));
      const sessionRefs = Array.isArray(draft.sessionRefs) ? draft.sessionRefs.filter((reference): reference is SessionReference =>
        !!reference && typeof reference === "object" && typeof reference.sessionId === "string" && /^sess_[A-Za-z0-9_-]+$/.test(reference.sessionId) && typeof reference.title === "string" && !!reference.title.trim()
      ).map(reference => ({ sessionId: reference.sessionId, title: reference.title })) : [];
      this.set(id, draft.text, chips, draftImages(draft.images), sessionRefs);
    }
  }

  get(id: string): ComposerDraft {
    return copy(this.drafts.get(id) ?? { text: "", chips: [] });
  }

  set(id: string, text: string, chips: ContextChip[], images: DraftImage[] = [], sessionRefs: SessionReference[] = []): void {
    const uniqueRefs = sessionRefs.filter((reference, index, all) =>
      /^sess_[A-Za-z0-9_-]+$/.test(reference.sessionId) && !!reference.title.trim() && all.findIndex(other => other.sessionId === reference.sessionId) === index
    ).map(reference => ({ ...reference }));
    const draft = {
      text,
      chips: chips.filter(chip => !chip.implicit).map(chip => ({ ...chip })),
      ...(uniqueRefs.length ? { sessionRefs: uniqueRefs } : {}),
      ...(images.length ? {images:images.map(image=>({...image}))} : {}),
    };
    if (!text && !draft.chips.length && !images.length && !uniqueRefs.length) this.drafts.delete(id);
    else this.drafts.set(id, draft);
  }

  /** Merge instead of overwriting text typed while an earlier send was pending. */
  recover(id: string, failed: ComposerDraft): ComposerDraft {
    const current = this.get(id);
    const text = !failed.text || current.text === failed.text ? current.text
      : current.text ? `${current.text}\n\n${failed.text}` : failed.text;
    const chips = [...current.chips];
    for (const chip of failed.chips) {
      if (!chips.some(existing => existing.path === chip.path && existing.selectionStart === chip.selectionStart && existing.selectionEnd === chip.selectionEnd)) {
        chips.push({ ...chip, implicit: false });
      }
    }
    const sessionRefs = [...(current.sessionRefs ?? [])];
    for (const reference of failed.sessionRefs ?? []) {
      if (!sessionRefs.some(existing => existing.sessionId === reference.sessionId)) sessionRefs.push({ ...reference });
    }
    const images = [...(current.images ?? [])];
    for (const image of failed.images ?? []) if (!images.some(existing=>existing.id===image.id)) images.push({...image});
    this.set(id, text, chips, images, sessionRefs);
    return this.get(id);
  }

  takePending(id: string): ComposerDraft {
    if (id) {
      const pending = this.get("");
      this.drafts.delete("");
      if (pending.text || pending.chips.length || pending.sessionRefs?.length || pending.images?.length) this.recover(id, pending);
    }
    return this.get(id);
  }

  serialize(): Record<string, ComposerDraft> {
    return Object.fromEntries([...this.drafts].map(([id, draft]) => [id, copy(draft)]));
  }
}
