CREATE TABLE "npi_lifecycle_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"program_id" uuid NOT NULL,
	"kind" varchar(30) NOT NULL,
	"title" varchar(200) NOT NULL,
	"planned_date" date,
	"performed_date" date,
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"result" varchar(30) DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"issue_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD COLUMN "lifecycle_record_id" uuid;--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD COLUMN "analysis" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD COLUMN "conclusion" varchar(30) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "npi_lifecycle_records" ADD CONSTRAINT "npi_lifecycle_records_program_id_npi_projects_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."npi_projects"("program_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_lifecycle_records" ADD CONSTRAINT "npi_lifecycle_records_issue_id_npi_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."npi_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_lifecycle_records" ADD CONSTRAINT "npi_lifecycle_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_lifecycle_records" ADD CONSTRAINT "npi_lifecycle_records_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npi_lifecycle_project" ON "npi_lifecycle_records" USING btree ("program_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD CONSTRAINT "npi_attachments_lifecycle_record_id_npi_lifecycle_records_id_fk" FOREIGN KEY ("lifecycle_record_id") REFERENCES "public"."npi_lifecycle_records"("id") ON DELETE no action ON UPDATE no action;