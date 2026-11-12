-- Grant the new modules to existing roles (new schools get them from DEFAULT_ROLES).
UPDATE roles SET permissions = permissions || '["certificates.view","certificates.create","certificates.edit","certificates.delete","certificates.approve","certificates.export","messaging.view","messaging.create","messaging.edit","messaging.delete","messaging.approve","messaging.export"]'::jsonb
WHERE key = 'school_admin';
--> statement-breakpoint
UPDATE roles SET permissions = permissions || '["certificates.view","certificates.create","certificates.edit","certificates.delete","certificates.approve","certificates.export","messaging.view","messaging.create"]'::jsonb
WHERE key = 'principal';
--> statement-breakpoint
UPDATE roles SET permissions = permissions || '["messaging.view","messaging.create"]'::jsonb
WHERE key = 'accountant';
--> statement-breakpoint
-- Plans that already include communication get the new delivery and certificate features.
UPDATE plans SET features = features || '["messaging","certificates"]'::jsonb
WHERE features ? 'communication' AND NOT features ? 'messaging';
