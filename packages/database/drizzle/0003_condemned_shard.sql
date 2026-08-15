CREATE UNIQUE INDEX `uq_protected_values_matter_public_token` ON `protected_values` (`matter_id`,`public_token`) WHERE "protected_values"."public_token" IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `protected_values_public_token_immutable`
BEFORE UPDATE OF `public_token` ON `protected_values`
WHEN OLD.`public_token` IS NOT NULL AND NEW.`public_token` IS NOT OLD.`public_token`
BEGIN
	SELECT RAISE(ABORT, 'protected_values.public_token is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `protected_values_public_token_format_insert`
BEFORE INSERT ON `protected_values`
WHEN NEW.`public_token` IS NOT NULL AND (
	NEW.`public_token` NOT GLOB '@[A-Z]-[A-Z0-9]*'
	OR substr(NEW.`public_token`, 4) GLOB '*[^A-Z0-9]*'
)
BEGIN
	SELECT RAISE(ABORT, 'protected_values.public_token has an invalid format');
END;
--> statement-breakpoint
CREATE TRIGGER `protected_values_public_token_format_update`
BEFORE UPDATE OF `public_token` ON `protected_values`
WHEN NEW.`public_token` IS NOT NULL AND (
	NEW.`public_token` NOT GLOB '@[A-Z]-[A-Z0-9]*'
	OR substr(NEW.`public_token`, 4) GLOB '*[^A-Z0-9]*'
)
BEGIN
	SELECT RAISE(ABORT, 'protected_values.public_token has an invalid format');
END;
