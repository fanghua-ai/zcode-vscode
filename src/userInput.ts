export interface InputQuestion {
  question: string;
  multiSelect?: boolean;
  options: Array<{ value: string }>;
}

/** Keep selections separate from the string-valued answers required by the CLI. */
export class QuestionAnswers {
  private readonly selections = new Map<number, Set<string>>();

  constructor(private readonly questions: InputQuestion[]) {}

  toggle(index: number, value: string): void {
    const question = this.questions[index];
    if (!question?.options.some((option) => option.value === value)) return;
    const selected = this.selections.get(index) ?? new Set<string>();
    if (!question.multiSelect) selected.clear();
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);
    this.selections.set(index, selected);
  }

  selected(index: number, value: string): boolean {
    return this.selections.get(index)?.has(value) ?? false;
  }

  complete(): boolean {
    return this.questions.length > 0 &&
      this.questions.every((_, index) => (this.selections.get(index)?.size ?? 0) > 0);
  }

  content(): { answer?: string; answers: Record<string, string> } {
    const answers = Object.fromEntries(this.questions.map((question, index) => [
      question.question,
      question.options.filter((option) => this.selected(index, option.value))
        .map((option) => option.value).join(", "),
    ]));
    return { answers, ...(this.questions.length === 1 ? { answer: answers[this.questions[0].question] } : {}) };
  }
}
