import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user, session } from "./schema";

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled"),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: jsonb("scopes").$type<string[]>(),
    clientCredentialsScopes: jsonb("client_credentials_scopes").$type<string[]>(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: jsonb("contacts").$type<string[]>(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    postLogoutRedirectUris: jsonb("post_logout_redirect_uris").$type<string[]>(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: jsonb("grant_types").$type<string[]>(),
    responseTypes: jsonb("response_types").$type<string[]>(),
    requirePKCE: boolean("require_p_k_c_e"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens"),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_client_0_idx").on(t.userId)],
);

export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: jsonb("allowed_scopes").$type<string[]>(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required"),
  disabled: boolean("disabled"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  policyVersion: integer("policy_version"),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [
    index("oauth_client_resource_0_idx").on(t.clientId),
    index("oauth_client_resource_1_idx").on(t.resourceId),
    uniqueIndex("oauth_client_resource_2_idx").on(t.clientId, t.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requested_user_info_claims").$type<string[]>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    revoked: timestamp("revoked", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", { withTimezone: true }),
    authTime: timestamp("auth_time", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
  },
  (t) => [
    index("oauth_refresh_token_0_idx").on(t.clientId),
    index("oauth_refresh_token_1_idx").on(t.sessionId),
    index("oauth_refresh_token_2_idx").on(t.userId),
    index("oauth_refresh_token_3_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requested_user_info_claims").$type<string[]>(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    revoked: timestamp("revoked", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
  },
  (t) => [
    index("oauth_access_token_0_idx").on(t.clientId),
    index("oauth_access_token_1_idx").on(t.sessionId),
    index("oauth_access_token_2_idx").on(t.userId),
    index("oauth_access_token_3_idx").on(t.authorizationCodeId),
    index("oauth_access_token_4_idx").on(t.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requested_user_info_claims").$type<string[]>(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("oauth_consent_0_idx").on(t.clientId), index("oauth_consent_1_idx").on(t.userId)],
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const deviceCode = pgTable(
  "device_code",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
    resources: jsonb("resources").$type<string[]>(),
    oauthClientId: text("oauth_client_id"),
  },
  (t) => [
    uniqueIndex("device_code_0_idx").on(t.deviceCode),
    uniqueIndex("device_code_1_idx").on(t.userCode),
    uniqueIndex("device_code_client_idx").on(t.clientId),
  ],
);
