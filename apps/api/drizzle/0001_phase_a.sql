CREATE TABLE "certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"serial_no" varchar(50) NOT NULL,
	"data" jsonb NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "credit_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"pack_key" varchar(30) NOT NULL,
	"credits" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"gateway" varchar(20) NOT NULL,
	"gateway_order_id" varchar(100),
	"gateway_payment_id" varchar(100),
	"created_by" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"note" text,
	"amount_paid" numeric(12, 2),
	"reference" varchar(120),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid,
	"channel" varchar(12) NOT NULL,
	"event" varchar(40) NOT NULL,
	"recipient" varchar(255) NOT NULL,
	"recipient_name" varchar(200),
	"student_id" uuid,
	"user_id" uuid,
	"subject" varchar(255),
	"body" text NOT NULL,
	"params" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachment" jsonb,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"provider_ref" varchar(120),
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "school_integrations" (
	"school_id" uuid NOT NULL,
	"provider" varchar(30) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_integrations_school_id_provider_pk" PRIMARY KEY("school_id","provider")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "messaging" jsonb DEFAULT '{"channels":{"email":true,"whatsapp":false,"sms":false},"events":{"fee_reminder":["email","whatsapp"],"fee_receipt":["email","whatsapp"],"attendance_absent":["whatsapp","sms"],"attendance_low":["email","whatsapp"],"exam_results":["email","whatsapp"],"exam_scheduled":["email"],"homework":[],"meeting":["email","whatsapp"],"announcement":["email","whatsapp"],"event":["email"],"portal_credentials":["whatsapp","sms"],"admission":["email","sms"]},"lowCreditAlert":200}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "message_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_orders" ADD CONSTRAINT "credit_orders_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_integrations" ADD CONSTRAINT "school_integrations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cert_school_serial" ON "certificates" USING btree ("school_id","serial_no");--> statement-breakpoint
CREATE INDEX "cert_student" ON "certificates" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "credit_tx_school" ON "credit_transactions" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_school_created" ON "outbound_messages" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_status" ON "outbound_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbound_provider_ref" ON "outbound_messages" USING btree ("provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "users_school_phone" ON "users" USING btree ("school_id","phone") WHERE phone is not null;