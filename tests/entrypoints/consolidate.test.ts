import { describe, expect, it } from "vitest";
import { parseExtractResponse } from "../../src/entrypoints/consolidate.ts";

describe("parseExtractResponse", () => {
    it("parses valid bare JSON", () => {
        const raw = `{"newFacts":[{"subject":"pkg-manager","value":"npm"}],"newEvents":[]}`;
        expect(parseExtractResponse(raw)).toEqual({
            newFacts: [{ subject: "pkg-manager", value: "npm" }],
            newEvents: [],
        });
    });

    it("unwraps ```json fence", () => {
        const raw = '```json\n{"newFacts":[],"newEvents":[]}\n```';
        expect(parseExtractResponse(raw)).toEqual({
            newFacts: [],
            newEvents: [],
        });
    });

    it("unwraps plain ``` fence", () => {
        const raw = '```\n{"newFacts":[],"newEvents":[]}\n```';
        expect(parseExtractResponse(raw)).toEqual({
            newFacts: [],
            newEvents: [],
        });
    });

    it("throws on malformed JSON with a 120-char snippet", () => {
        const raw = "not-json-at-all";
        expect(() => parseExtractResponse(raw)).toThrow(/not-json-at-all/);
    });

    it("throws when newFacts is missing", () => {
        expect(() => parseExtractResponse(`{"newEvents":[]}`)).toThrow(
            /newFacts/,
        );
    });

    it("throws when newEvents is missing", () => {
        expect(() => parseExtractResponse(`{"newFacts":[]}`)).toThrow(
            /newEvents/,
        );
    });

    it("ignores extra top-level keys (forward-compat)", () => {
        const raw = `{"newFacts":[],"newEvents":[],"notes":"ignored"}`;
        expect(parseExtractResponse(raw)).toEqual({
            newFacts: [],
            newEvents: [],
        });
    });

    it("throws when newFacts item is malformed", () => {
        const raw = `{"newFacts":[{"subject":"x"}],"newEvents":[]}`;
        expect(() => parseExtractResponse(raw)).toThrow();
    });

    it("throws when newEvents item is malformed", () => {
        const raw = `{"newFacts":[],"newEvents":[{"date":"2026-04-20"}]}`;
        expect(() => parseExtractResponse(raw)).toThrow();
    });
});
