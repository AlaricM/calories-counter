#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { FoodTrackerStack } from "../lib/food-tracker-stack";

const app = new cdk.App();

// Accept the API key either via `cdk deploy -c apiKey=...` or via .env / MCP_API_KEY
const apiKey: string | undefined =
  app.node.tryGetContext("apiKey") ?? process.env.MCP_API_KEY;

if (!apiKey || apiKey.length < 16) {
  throw new Error(
    "Missing or too-short MCP API key. Copy .env.example to .env and set MCP_API_KEY " +
      "(24+ random hex chars), or pass -c apiKey=<secret> on the command line."
  );
}

new FoodTrackerStack(app, "FoodTrackerMcpStack", {
  apiKey,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
