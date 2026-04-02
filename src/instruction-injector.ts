import type { InjectedSection } from "./types.js";

export class InstructionInjector {
  constructor(private readonly sources: Record<string, string>) {}

  inject(sectionNames: string[]): InjectedSection[] {
    return sectionNames
      .map((section) => {
        const content = this.sources[section]?.trim();
        if (!content) {
          return null;
        }
        return {
          section,
          content,
        } satisfies InjectedSection;
      })
      .filter((value): value is InjectedSection => value !== null);
  }
}
