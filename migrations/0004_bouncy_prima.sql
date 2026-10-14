CREATE TABLE "npi_motor_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npi_motor_types_name_unique" UNIQUE("name")
);

--> statement-breakpoint
INSERT INTO npi_motor_types (name, created_at) VALUES
('三相异步电动机', '2026-10-14 00:00:00+00'),
('永磁同步电动机', '2026-10-14 00:00:01+00'),
('磁阻电机', '2026-10-14 00:00:02+00'),
('直驱电机', '2026-10-14 00:00:03+00'),
('零部件代工', '2026-10-14 00:00:04+00')
ON CONFLICT (name) DO NOTHING;
