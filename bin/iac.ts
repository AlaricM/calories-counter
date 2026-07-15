#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { FoodTrackerStack } from "../lib/food-tracker-stack";

const app = new cdk.App();

// No shared secret needed to deploy anymore — auth is per-user and lives in the
// users DynamoDB table (managed with `npm run user`). .env is optional and only
// carries the cost-alert settings below.
const alertEmail = process.env.ALERT_EMAIL?.trim() || undefined;
const monthlyBudgetUsd = process.env.MONTHLY_BUDGET_USD
  ? Number(process.env.MONTHLY_BUDGET_USD)
  : undefined;

new FoodTrackerStack(app, "FoodTrackerMcpStack", {
  alertEmail,
  monthlyBudgetUsd,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
