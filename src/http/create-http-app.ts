import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NextFunction, Request, Response } from "express";

import type { VisualAllowlist } from "../domain/visual-policy.js";
import type {
  Clock,
  ObservabilityProvider,
  ObservabilityVisualProvider,
} from "../providers/observability-provider.js";
import { createCIServer, createObservabilityServer } from "../server/create-server.js";
import type { CIService } from "../ci/service.js";

export interface CreateObservabilityHttpAppOptions {
  readonly provider?: ObservabilityProvider;
  readonly bearerToken: string;
  readonly host: string;
  readonly allowedHosts: readonly string[];
  readonly clock?: Clock;
  readonly visualAllowlist?: VisualAllowlist;
  readonly visualProvider?: ObservabilityVisualProvider;
  readonly ci?: CIService;
}

export function createObservabilityHttpApp(options: CreateObservabilityHttpAppOptions) {
  if (options.bearerToken.length < 16) {
    throw new Error("MCP HTTP bearer token must contain at least 16 characters");
  }
  if (options.allowedHosts.length === 0) {
    throw new Error("MCP HTTP allowed hosts must not be empty");
  }
  if (options.provider === undefined && options.ci === undefined) {
    throw new Error("MCP HTTP app requires an enabled runtime module");
  }

  const app = createMcpExpressApp({
    host: options.host,
    allowedHosts: [...options.allowedHosts],
  });

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  const ci = options.ci;
  if (ci !== undefined) {
    registerMcpEndpoint("/mcp/ci", () => createCIServer({
      ci,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }));
  }
  const provider = options.provider;
  if (provider !== undefined) {
    registerMcpEndpoint("/mcp", () => createObservabilityServer({
      provider,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.visualAllowlist === undefined
        ? {}
        : { visualAllowlist: options.visualAllowlist }),
      ...(options.visualProvider === undefined ? {} : { visualProvider: options.visualProvider }),
      ...(ci === undefined ? {} : { ci }),
    }));
  }

  return app;

  function registerMcpEndpoint(path: string, createServer: () => ReturnType<typeof createObservabilityServer>): void {
    app.use(path, bearerAuthentication(options.bearerToken));
    app.post(path, async (request, response) => {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport();
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await transport.close();
        await server.close();
      };
      response.once("close", () => void close());

      try {
        // SDK 1.29's Node transport declaration is not exactOptionalPropertyTypes-clean.
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(request, response, request.body);
      } catch {
        await close();
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });
    app.get(path, methodNotAllowed);
    app.delete(path, methodNotAllowed);
  }
}

function bearerAuthentication(expectedToken: string) {
  const expected = Buffer.from(expectedToken);
  return (request: Request, response: Response, next: NextFunction): void => {
    const authorization = request.header("authorization");
    const supplied = authorization?.startsWith("Bearer ")
      ? Buffer.from(authorization.slice("Bearer ".length))
      : undefined;
    const matches =
      supplied !== undefined &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected);

    if (!matches) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function methodNotAllowed(_request: Request, response: Response): void {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
}
