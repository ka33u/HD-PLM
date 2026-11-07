CREATE TABLE "account_registrations" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"department_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_registrations" ADD CONSTRAINT "account_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_registrations" ADD CONSTRAINT "account_registrations_department_id_npi_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."npi_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Keep existing departments and memberships. Supply a choice only for categories
-- that have no group yet; never infer or move existing users.
INSERT INTO npi_departments (name, role)
SELECT defaults.name, defaults.role FROM (VALUES
  ('设计部', 'technical'), ('生产部', 'manufacturing'), ('采购部', 'procurement')
) AS defaults(name, role)
WHERE NOT EXISTS (SELECT 1 FROM npi_departments d WHERE d.role = defaults.role)
ON CONFLICT (name) DO NOTHING;
