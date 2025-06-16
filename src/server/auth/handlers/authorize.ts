import { RequestHandler } from "express";
import { z } from "zod";
import express from "express";
import { OAuthServerProvider } from "../provider.js";
import { rateLimit, Options as RateLimitOptions } from "express-rate-limit";
import { allowedMethods } from "../middleware/allowedMethods.js";
import {
  InvalidRequestError,
  InvalidClientError,
  InvalidScopeError,
  InvalidTargetError,
  ServerError,
  TooManyRequestsError,
  OAuthError
} from "../errors.js";
import { OAuthServerConfig } from "../types.js";
import { resourceUrlFromServerUrl } from "../../../shared/auth-utils.js";

export type AuthorizationHandlerOptions = {
  provider: OAuthServerProvider;
  /**
   * Rate limiting configuration for the authorization endpoint.
   * Set to false to disable rate limiting for this endpoint.
   */
  rateLimit?: Partial<RateLimitOptions> | false;
  /**
   * OAuth server configuration options
   */
  config?: OAuthServerConfig;
};

// Parameters that must be validated in order to issue redirects.
const ClientAuthorizationParamsSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string().optional().refine((value) => value === undefined || URL.canParse(value), { message: "redirect_uri must be a valid URL" }),
});

// Parameters that must be validated for a successful authorization request. Failure can be reported to the redirect URI.
const RequestAuthorizationParamsSchema = z.object({
  response_type: z.literal("code"),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().url().optional(),
});

export function authorizationHandler({ provider, rateLimit: rateLimitConfig, config }: AuthorizationHandlerOptions): RequestHandler {
  // Validate configuration
  if (config?.validateResourceMatchesServer && !config?.serverUrl) {
    throw new Error("serverUrl must be configured when validateResourceMatchesServer is true");
  }

  // Create a router to apply middleware
  const router = express.Router();
  router.use(allowedMethods(["GET", "POST"]));
  router.use(express.urlencoded({ extended: false }));

  // Apply rate limiting unless explicitly disabled
  if (rateLimitConfig !== false) {
    router.use(rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // 100 requests per windowMs
      standardHeaders: true,
      legacyHeaders: false,
      message: new TooManyRequestsError('You have exceeded the rate limit for authorization requests').toResponseObject(),
      ...rateLimitConfig
    }));
  }

  router.all("/", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    // In the authorization flow, errors are split into two categories:
    // 1. Pre-redirect errors (direct response with 400)
    // 2. Post-redirect errors (redirect with error parameters)

    // Phase 1: Validate client_id and redirect_uri. Any errors here must be direct responses.
    let client_id, redirect_uri, client;
    try {
      const result = ClientAuthorizationParamsSchema.safeParse(req.method === 'POST' ? req.body : req.query);
      if (!result.success) {
        throw new InvalidRequestError(result.error.message);
      }

      client_id = result.data.client_id;
      redirect_uri = result.data.redirect_uri;

      client = await provider.clientsStore.getClient(client_id);
      if (!client) {
        throw new InvalidClientError("Invalid client_id");
      }

      if (redirect_uri !== undefined) {
        if (!client.redirect_uris.includes(redirect_uri)) {
          throw new InvalidRequestError("Unregistered redirect_uri");
        }
      } else if (client.redirect_uris.length === 1) {
        redirect_uri = client.redirect_uris[0];
      } else {
        throw new InvalidRequestError("redirect_uri must be specified when client has multiple registered URIs");
      }
    } catch (error) {
      // Pre-redirect errors - return direct response
      //
      // These don't need to be JSON encoded, as they'll be displayed in a user
      // agent, but OTOH they all represent exceptional situations (arguably,
      // "programmer error"), so presenting a nice HTML page doesn't help the
      // user anyway.
      if (error instanceof OAuthError) {
        const status = error instanceof ServerError ? 500 : 400;
        res.status(status).json(error.toResponseObject());
      } else {
        console.error("Unexpected error looking up client:", error);
        const serverError = new ServerError("Internal Server Error");
        res.status(500).json(serverError.toResponseObject());
      }

      return;
    }

    // Phase 2: Validate other parameters. Any errors here should go into redirect responses.
    let state;
    try {
      // Parse and validate authorization parameters
      const parseResult = RequestAuthorizationParamsSchema.safeParse(req.method === 'POST' ? req.body : req.query);
      if (!parseResult.success) {
        throw new InvalidRequestError(parseResult.error.message);
      }

      const { scope, code_challenge, resource } = parseResult.data;
      state = parseResult.data.state;

      // If validateResourceMatchesServer is enabled, resource is required and must match
      if (config?.validateResourceMatchesServer) {
        if (!resource) {
          throw new InvalidRequestError("Resource parameter is required when server URL validation is enabled");
        }
        
        // Remove fragment from server URL if present (though it shouldn't have one)
        const canonicalServerUrl = resourceUrlFromServerUrl(config.serverUrl!);
        
        if (resource !== canonicalServerUrl) {
          throw new InvalidTargetError(
            `Resource parameter '${resource}' does not match this server's URL '${canonicalServerUrl}'`
          );
        }
      } else {
        // Always log warning if resource is missing (unless validation is enabled)
        if (!resource) {
          console.warn(`Authorization request from client ${client_id} is missing the resource parameter. Consider migrating to RFC 8707.`);
        }
      }

      // Validate scopes
      let requestedScopes: string[] = [];
      if (scope !== undefined) {
        requestedScopes = scope.split(" ");
        const allowedScopes = new Set(client.scope?.split(" "));

        // Check each requested scope against allowed scopes
        for (const scope of requestedScopes) {
          if (!allowedScopes.has(scope)) {
            throw new InvalidScopeError(`Client was not registered with scope ${scope}`);
          }
        }
      }

      // All validation passed, proceed with authorization
      await provider.authorize(client, {
        state,
        scopes: requestedScopes,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        resource,
      }, res);
    } catch (error) {
      // Post-redirect errors - redirect with error parameters
      if (error instanceof OAuthError) {
        res.redirect(302, createErrorRedirect(redirect_uri, error, state));
      } else {
        console.error("Unexpected error during authorization:", error);
        const serverError = new ServerError("Internal Server Error");
        res.redirect(302, createErrorRedirect(redirect_uri, serverError, state));
      }
    }
  });

  return router;
}

/**
 * Helper function to create redirect URL with error parameters
 */
function createErrorRedirect(redirectUri: string, error: OAuthError, state?: string): string {
  const errorUrl = new URL(redirectUri);
  errorUrl.searchParams.set("error", error.errorCode);
  errorUrl.searchParams.set("error_description", error.message);
  if (error.errorUri) {
    errorUrl.searchParams.set("error_uri", error.errorUri);
  }
  if (state) {
    errorUrl.searchParams.set("state", state);
  }
  return errorUrl.href;
}