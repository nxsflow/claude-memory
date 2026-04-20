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
}
