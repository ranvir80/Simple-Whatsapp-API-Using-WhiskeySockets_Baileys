-- ============================================
-- WhatsApp API Server - Supabase Database Setup
-- ============================================
-- Run this SQL in your Supabase SQL Editor
-- ============================================

-- Auth Data table (stores WhatsApp authentication state)
CREATE TABLE IF NOT EXISTS public.auth_data (
  session_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_data TEXT NOT NULL,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CONSTRAINT auth_data_pkey PRIMARY KEY (session_id, file_name)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_auth_data_session 
ON public.auth_data USING BTREE (session_id) TABLESPACE pg_default;

-- Messages table (stores all incoming and outgoing messages)
CREATE TABLE IF NOT EXISTS public.messages (
  id BIGSERIAL NOT NULL,
  message_id TEXT,
  jid TEXT,
  from_plain_phone TEXT,
  display_name TEXT,
  type TEXT,
  text TEXT,
  media_mimetype TEXT,
  media_filename TEXT,
  media_size BIGINT,
  reaction_text TEXT,
  is_reply BOOLEAN DEFAULT FALSE,
  reply_to_message_id TEXT,
  reply_to_text TEXT,
  chat_type TEXT,
  from_me BOOLEAN DEFAULT FALSE,
  received_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  raw JSONB,
  direction TEXT,
  media_unique_id TEXT,
  telegram_message_id TEXT,
  telegram_file_id TEXT,
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT unique_media_id UNIQUE (media_unique_id)
) TABLESPACE pg_default;

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_messages_jid 
ON public.messages USING BTREE (jid) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_messages_message_id 
ON public.messages USING BTREE (message_id) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_messages_direction 
ON public.messages USING BTREE (direction) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_messages_created_at 
ON public.messages USING BTREE (created_at DESC) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_messages_from_plain_phone 
ON public.messages USING BTREE (from_plain_phone) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_messages_type 
ON public.messages USING BTREE (type) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_messages_media_unique_id 
ON public.messages USING BTREE (media_unique_id) TABLESPACE pg_default;

-- Connection logs table (monitors connection events)
CREATE TABLE IF NOT EXISTS public.connection_logs (
  id BIGSERIAL NOT NULL,
  event_type TEXT,
  status_code INTEGER,
  reason TEXT,
  attempt_number INTEGER,
  timestamp TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CONSTRAINT connection_logs_pkey PRIMARY KEY (id)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_connection_logs_timestamp 
ON public.connection_logs USING BTREE (timestamp DESC) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_connection_logs_event_type 
ON public.connection_logs USING BTREE (event_type) TABLESPACE pg_default;

-- ============================================
-- Useful Queries
-- ============================================

-- View all auth files for a session
-- SELECT session_id, file_name, LENGTH(file_data) as size, updated_at 
-- FROM auth_data 
-- WHERE session_id = 'default'
-- ORDER BY file_name;

-- Count auth files per session
-- SELECT session_id, COUNT(*) as file_count 
-- FROM auth_data 
-- GROUP BY session_id;

-- View recent messages with media info
-- SELECT 
--   display_name, 
--   type, 
--   text, 
--   direction,
--   from_me,
--   media_unique_id,
--   telegram_file_id,
--   created_at 
-- FROM messages 
-- ORDER BY created_at DESC 
-- LIMIT 50;

-- View only media messages
-- SELECT 
--   display_name,
--   media_filename,
--   media_mimetype,
--   media_size,
--   media_unique_id,
--   telegram_message_id,
--   created_at
-- FROM messages
-- WHERE media_unique_id IS NOT NULL
-- ORDER BY created_at DESC;

-- View connection issues
-- SELECT 
--   event_type,
--   reason,
--   attempt_number,
--   timestamp
-- FROM connection_logs
-- WHERE event_type IN ('loggedOut', 'badSession', 'connectionLost')
-- ORDER BY timestamp DESC
-- LIMIT 20;

-- View connection history
-- SELECT * FROM connection_logs 
-- ORDER BY timestamp DESC 
-- LIMIT 20;

-- Count messages by type
-- SELECT type, COUNT(*) as count 
-- FROM messages 
-- GROUP BY type 
-- ORDER BY count DESC;

-- View messages from specific number
-- SELECT * FROM messages 
-- WHERE from_plain_phone = '919876543210'
-- ORDER BY created_at DESC;

-- Clear auth data for specific session (force logout and get new QR)
-- DELETE FROM auth_data WHERE session_id = 'default';
