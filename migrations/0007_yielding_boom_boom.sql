CREATE TABLE "npi_quality_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"program_id" uuid NOT NULL,
	"kind" varchar(30) NOT NULL,
	"title" varchar(200) NOT NULL,
	"performed_date" date,
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"result" varchar(30) DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"exception_status" varchar(30) DEFAULT 'none' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD COLUMN "quality_record_id" uuid;--> statement-breakpoint
ALTER TABLE "npi_quality_records" ADD CONSTRAINT "npi_quality_records_program_id_npi_projects_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."npi_projects"("program_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_quality_records" ADD CONSTRAINT "npi_quality_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npi_quality_records" ADD CONSTRAINT "npi_quality_records_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npi_quality_project" ON "npi_quality_records" USING btree ("program_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "npi_attachments" ADD CONSTRAINT "npi_attachments_quality_record_id_npi_quality_records_id_fk" FOREIGN KEY ("quality_record_id") REFERENCES "public"."npi_quality_records"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO npi_departments (name, role)
SELECT CASE WHEN EXISTS(SELECT 1 FROM npi_departments WHERE name='质量部') THEN '质量部（质量岗位）' ELSE '质量部' END, 'quality'
WHERE NOT EXISTS (SELECT 1 FROM npi_departments WHERE role='quality')
ON CONFLICT (name) DO NOTHING;
