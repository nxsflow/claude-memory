export interface Exchange {
    role: "user" | "assistant";
    text: string;
}

export interface HaikuResponse {
    text: string;
    isSkip: boolean;
    tokensIn: number;
    tokensOut: number;
    tokensCache: number;
    costUsd: number;
}

export interface LastSave {
    session: string;
    line: number;
}

export interface Config {
    cooldowns: { saveSeconds: number; compactSeconds: number };
    thresholds: { minHumanMessages: number; deltaLinesTrigger: number };
    features: { recovery: boolean };
    timezone: string;
    eventHorizonDays: number;
    tokenSoftCap: { shortTerm: number; longTerm: number };
}

export interface StateFact {
    id: string;
    subject: string;
    value: string;
    validFrom: string;
    supersededBy?: string;
    supersededOn?: string;
    supersedes?: string[];
}

export interface EventRecord {
    id: string;
    date: string;
    summary: string;
}

export interface WeeklyRecord {
    id: string;
    weekOf: string;
    summary: string;
}

export interface TemporalStore {
    version: 1;
    state: StateFact[];
    events: {
        recent: EventRecord[];
        weekly: WeeklyRecord[];
    };
}

export interface ExtractedPayload {
    newFacts: { subject: string; value: string }[];
    newEvents: { date: string; summary: string }[];
}
