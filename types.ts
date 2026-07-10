export type FoodItem = {
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

export type AddAliasInput = {
    food: string;
    alias: string;
}

export type FindFoodItemInput = {
    query: string;
}

export type FindFoodItemOutput = {
    items: FoodItem[];
}