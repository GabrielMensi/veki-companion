-- Pertenencia de cada foto/video a su álbum de Telegram (docs/02 §2.3).
-- Nullable: las filas anteriores no la tienen; sus álbumes siguen leyéndose de event_log (`media.group_member`).
ALTER TABLE media ADD COLUMN media_group_id TEXT;
CREATE INDEX idx_media_group ON media(media_group_id);
