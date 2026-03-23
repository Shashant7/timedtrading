
    INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by)
    VALUES ('ai_cio_reference_enabled', 'false', 'Matrix toggle ai_cio_reference_enabled', CAST(strftime('%s','now') AS INTEGER)*1000, 'matrix')
    ON CONFLICT(config_key) DO UPDATE SET
      config_value=excluded.config_value,
      description=excluded.description,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by;
    