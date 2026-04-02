import type { InjectedSection } from "./types.js";
export declare class InstructionInjector {
    private readonly sources;
    constructor(sources: Record<string, string>);
    inject(sectionNames: string[]): InjectedSection[];
}
