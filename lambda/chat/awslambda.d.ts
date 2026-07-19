/**
 * Ambient types for the Lambda response-streaming globals. These are provided by
 * the AWS Lambda Node.js runtime (not an npm package), so we declare the small
 * surface we use. See lambda/chat/index.ts and the Function URL RESPONSE_STREAM
 * invoke mode wired up in lib/food-tracker-stack.ts.
 */
import type { Writable } from "node:stream";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace awslambda {
    interface ResponseStream extends Writable {
      setContentType(type: string): void;
    }

    interface HttpResponseMetadata {
      statusCode?: number;
      headers?: Record<string, string>;
    }

    const HttpResponseStream: {
      from(stream: ResponseStream, metadata: HttpResponseMetadata): ResponseStream;
    };

    function streamifyResponse(
      handler: (event: any, responseStream: ResponseStream, context: any) => Promise<void>
    ): (event: any, context: any) => Promise<void>;
  }
}

export {};
