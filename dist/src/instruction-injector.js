export class InstructionInjector {
    sources;
    constructor(sources) {
        this.sources = sources;
    }
    inject(sectionNames) {
        return sectionNames
            .map((section) => {
            const content = this.sources[section]?.trim();
            if (!content) {
                return null;
            }
            return {
                section,
                content,
            };
        })
            .filter((value) => value !== null);
    }
}
