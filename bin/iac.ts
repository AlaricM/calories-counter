#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { FoodTrackerStack } from "../lib/food-tracker-stack";

const app = new cdk.App();

// The one required setting is OPENAI_API_KEY (the chat backend + nutrition search
// call OpenAI). It's read from .env and injected as a Lambda env var — $0 and
// simplest; the alternative (SSM SecureString) adds moving parts for no real gain
// at single-user scale. Per-user auth still lives in the users DynamoDB table
// (managed with `npm run user`); the rest below is optional cost-alert config.
const openaiApiKey = process.env.OPENAI_API_KEY?.trim() || undefined;
const alertEmail = process.env.ALERT_EMAIL?.trim() || undefined;
const monthlyBudgetUsd = process.env.MONTHLY_BUDGET_USD
  ? Number(process.env.MONTHLY_BUDGET_USD)
  : undefined;

if (!openaiApiKey) {
  console.warn(
    "WARN: OPENAI_API_KEY is not set in .env — the app will deploy, but the chat " +
      "backend will error on every request until you set it and redeploy.",
  );
}

// Stack id kept as-is ("FoodTrackerMcpStack") so the existing DynamoDB tables and
// scoped IAM ARNs (iam/*.json reference FoodTrackerMcpStack-*) keep working —
// renaming would orphan the RETAIN tables and break those policies.
new FoodTrackerStack(app, "FoodTrackerMcpStack", {
  openaiApiKey,
  alertEmail,
  monthlyBudgetUsd,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
