export type FoodItem = {
    userId: string;
    itemLower: string;
    item: string;
    aliases: string[];
    calories: number;
    proteinG?: number;
    fatG?: number;
    carbsG?: number;
    serving?: string;
}

export type AddFoodItemInput = {
    item: string;
    aliases?: string[];
    calories: number;
    proteinG?: number;
    fatG?: number;
    carbsG?: number;
    serving?: string;
}

export type AddFoodToDailyCountInput = {
    query: string;
    quantity?: number;
    serving?: string;
}

export type ListDailyEntriesInput = {
    day?: string;
}

export type DeleteDailyEntryInput = {
    day?: string;
    order: number;
}

export type DailyTrackerEntry = {
    userId: string;
    dayOrder: string;
    day: string;
    order: number;
    item: string;
    calories: number;
    proteinG: number;
    fatG: number;
    carbsG: number;
    cumulativeCalories: number;
    cumulativeProteinG: number;
    cumulativeFatG: number;
    cumulativeCarbsG: number;
    serving?: string;
}

export type AddAliasInput = {
    food: string;
    alias: string;
}

export type FindFoodItemInput = {
    query: string;
}

export type DeleteFoodItemInput = {
    item: string;
}

export type FindFoodItemOutput = {
    items: FoodItem[];
}

/**
 * A user of the MCP server. One API key = one user. Only the SHA-256 hash of
 * the key is stored (see lambda/mcp-server/hash.ts), so a table read can't
 * recover anyone's usable credential.
 */
export type UserRecord = {
    apiKeyHash: string;
    userId: string;
    name: string;
    createdAt: string;
}
