CREATE TABLE "chat"."mcp_connection" (
	"user_id" text,
	"server_key" text,
	"encrypted" text,
	"scopes" text,
	"pending_state" text,
	"pending_encrypted" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connection_pkey" PRIMARY KEY("user_id","server_key")
);
