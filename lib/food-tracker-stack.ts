import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

interface FoodTrackerStackProps extends cdk.StackProps {
  /** Shared-secret token embedded in the MCP server's URL path. */
  apiKey: string;
}

export class FoodTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FoodTrackerStackProps) {
    super(scope, id, props);

    // --- Storage -----------------------------------------------------
    // Provisioned (not on-demand) so this stays inside DynamoDB's
    // "Always Free" 25 RCU / 25 WCU allowance indefinitely.
    const table = new dynamodb.Table(this, "FoodItemsTable", {
      tableName: "food-tracker-items",
      partitionKey: { name: "itemLower", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // don't lose your food log on `cdk destroy`
    });

    // --- Compute --------------------------------------------------------
    const mcpFn = new NodejsFunction(this, "McpServerFunction", {
      entry: path.join(import.meta.dirname, "../lambda/mcp-server/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64, // Graviton2: faster + cheaper, pure-JS deps so zero compat risk
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: {
        TABLE_NAME: table.tableName,
        MCP_API_KEY: props.apiKey,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        // No explicit `target` — NodejsFunction derives a matching esbuild
        // target from `runtime` automatically, which avoids depending on
        // esbuild's version having already added an explicit "node24" target string.
      },
    });

    table.grantReadWriteData(mcpFn);

    // --- Public HTTPS endpoint -------------------------------------------
    // Function URLs are free and, unlike API Gateway, support the chunked
    // responses the MCP Streamable HTTP transport can use.
    const fnUrl = mcpFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedHeaders: ["Content-Type", "Accept", "Authorization", "Mcp-Session-Id"],
      },
    });

    const mcpBaseUrl = `${fnUrl.url}mcp`;

    new cdk.CfnOutput(this, "McpServerUrl", {
      value: `${mcpBaseUrl}/${props.apiKey}`,
      description:
        "Claude custom connector URL (secret embedded in path)",
    });

    new cdk.CfnOutput(this, "McpServerUrlForJoey", {
      value: mcpBaseUrl,
      description:
        "Joey MCP Client server URL (pair with McpServerAuthHeader)",
    });

    new cdk.CfnOutput(this, "McpServerAuthHeader", {
      value: `Authorization: Bearer ${props.apiKey}`,
      description:
        "Joey MCP Client auth header (Settings → Manage MCP Servers → Headers)",
    });
  }
}
