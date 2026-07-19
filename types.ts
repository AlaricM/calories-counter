/** Serving size stored as a precise weight (oz) or volume (floz), never freeform text. */
export type ServingUnit = "oz" | "floz";

export type ServingSize = {
    quantity: number;
    unit: ServingUnit;
}

export type FoodItem = {
    userId: string;
    itemLower: string;
    item: string;
    aliases: string[];
    calories: number;
    proteinG?: number;
    fatG?: number;
    carbsG?: number;
    serving?: ServingSize;
}

export type AddFoodItemInput = {
    item: string;
    aliases?: string[];
    calories: number;
    proteinG?: number;
    fatG?: number;
    carbsG?: number;
    serving?: ServingSize;
}

export type AddFoodToDailyCountInput = {
    query: string;
    quantity?: number;
    amountEaten?: string;
    serving?: ServingSize;
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
    serving?: ServingSize;
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
 * A user of the app. One API key = one user. Only the SHA-256 hash of the key is
 * stored (see lambda/shared/hash.ts), so a table read can't recover anyone's
 * usable credential.
 */
export type UserRecord = {
    apiKeyHash: string;
    userId: string;
    name: string;
    createdAt: string;
}
