ALTER TABLE "npi_projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "npi_projects" ADD COLUMN "deletion_reason" text DEFAULT '' NOT NULL;