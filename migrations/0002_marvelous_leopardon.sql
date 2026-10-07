CREATE TABLE "npi_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"role" varchar(30) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npi_departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "npi_user_roles" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "npi_user_roles" ADD CONSTRAINT "npi_user_roles_department_id_npi_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."npi_departments"("id") ON DELETE no action ON UPDATE no action;