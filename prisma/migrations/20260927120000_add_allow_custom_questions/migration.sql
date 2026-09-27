-- Opt-in free-text question box on the astrologer public site.
-- Defaults to false so every existing site renders exactly as it did before.
ALTER TABLE "astrologer_profiles"
    ADD COLUMN "allow_custom_questions" BOOLEAN NOT NULL DEFAULT false;
