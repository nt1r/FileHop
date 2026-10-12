-- Preserve existing Web sessions; native tokens cannot be used as Cookie credentials.
ALTER TABLE session ADD COLUMN kind TEXT NOT NULL DEFAULT 'web'
    CHECK (kind IN ('web', 'native'));
