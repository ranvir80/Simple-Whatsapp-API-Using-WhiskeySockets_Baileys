# WhatsApp API Server - Enhanced Version 🚀

Production-ready, single-file Baileys-based WhatsApp bot with Supabase storage, Telegram media storage, multi-webhook forwarding, and comprehensive message handling.

## ⚡ Quick Start

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd whatsappapi

# 2. Install dependencies
npm install

# 3. Copy and configure environment variables
cp .env.example .env
# Edit .env with your credentials

# 4. Set up Supabase database
# Run the SQL from setup.sql in your Supabase SQL Editor

# 5. Start the server
npm start

# 6. Scan QR code
# Visit http://localhost:5000/qr and scan with WhatsApp
```

## � Table of Contents

- [Features](#-features)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Usage](#-usage)
- [API Endpoints](#api-endpoints)
- [Webhook Forwarding](#-webhook-forwarding)
- [Reconnection Strategies](#-reconnection-strategies)
- [Message Types Supported](#-message-types-supported)
- [Security](#-security)
- [Monitoring](#-monitoring)
- [Testing](#-testing)
- [Troubleshooting](#-troubleshooting)
- [Deployment Tips](#-deployment-tips)
- [Database Schema Summary](#-database-schema-summary)

## �🚀 Features

- ✅ **Single file implementation** (`wa-api.js`)
- ✅ **Supabase-only storage** (no local session files)
- ✅ **Telegram media storage** (media files stored in Telegram using bot)
- ✅ **Multi-webhook forwarding** with retry logic
- ✅ **Media handling** (images, videos, documents, audio, stickers)
- ✅ **Auto-reconnection** with smart strategies and exponential backoff
- ✅ **QR webpage** with auto-refresh
- ✅ **Protected send endpoint** with rate limiting
- ✅ **Complete message logging** in Supabase
- ✅ **Support for reactions and replies**
- ✅ **Self-ping mechanism** to prevent server sleep on free hosting
- ✅ **Always online presence** - bot appears online 24/7
- ✅ **Blue tick (read receipts)** for all messages
- ✅ **Store all outgoing messages** (sent by you)
- ✅ **Forward all incoming messages** (no skips)

## 📋 Prerequisites

- Node.js 18+ 
- Supabase account with project created
- WhatsApp phone number for scanning QR code
- Telegram bot (create via @BotFather on Telegram)
- Telegram chat ID (use @userinfobot to get your chat ID)

## 🔧 Installation

1. **Clone or download this project**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up Supabase database**

   Run this SQL in your Supabase SQL Editor:

   ```sql
   -- Auth data table (stores WhatsApp session files)
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
   ```

4. **Configure environment variables**

   Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:
   ```env
   # Supabase Configuration
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_KEY=your-service-role-key
   
   # API Security
   AUTH_KEY=your-secret-api-key
   
   # Telegram Configuration (for media storage)
   TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
   TELEGRAM_CHAT_ID=your-telegram-chat-id
   
   # Webhook Configuration
   N8N_WEBHOOKS=https://webhook1.com,https://webhook2.com
   
   # Server Configuration
   PORT=5000
   QR_POLL_INTERVAL_MS=3000
   MAX_MEDIA_SIZE=52428800
   
   # Self-Ping Configuration (prevents server sleep on free hosting)
   SELF_PING_ENABLED=true
   SELF_PING_INTERVAL_MS=240000
   SELF_PING_URL=https://your-app.onrender.com/health
   
   # Session Configuration (optional)
   SESSION_ID=default
   
   # Presence Configuration (optional)
   PRESENCE_UPDATE_INTERVAL_MS=30000
   ```

   **Required Environment Variables:**
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_KEY` - Your Supabase service role key (found in Project Settings > API)
   - `AUTH_KEY` - A secure random string for API authentication (generate using: `openssl rand -hex 32`)
   - `TELEGRAM_BOT_TOKEN` - Create a bot via @BotFather on Telegram
   - `TELEGRAM_CHAT_ID` - Your Telegram user ID (get from @userinfobot)

   **Optional Environment Variables:**
   - `N8N_WEBHOOKS` - Comma-separated webhook URLs to forward messages to
   - `PORT` - Server port (default: 5000)
   - `MAX_MEDIA_SIZE` - Maximum media file size in bytes (default: 52428800 = 50MB)
   - `SELF_PING_ENABLED` - Enable self-ping to prevent sleep (default: true)
   - `SELF_PING_INTERVAL_MS` - Self-ping interval in milliseconds (default: 240000 = 4 minutes)
   - `SELF_PING_URL` - URL to ping (auto-detects if not set)
   - `SESSION_ID` - Session identifier for multiple instances (default: 'default')
   - `QR_POLL_INTERVAL_MS` - QR code refresh interval (default: 3000)
   - `PRESENCE_UPDATE_INTERVAL_MS` - Online presence update interval (default: 30000)

## 🎮 Usage

### Start the server

```bash
npm start
```

Or use nodemon for development:
```bash
npm install -g nodemon
nodemon wa-api.js
```

### Scan QR code

1. Visit `http://localhost:5000/qr`
2. Scan the QR code with WhatsApp mobile app
3. Page will automatically update when connected

### API Endpoints

#### 1. **Health Check**
```bash
GET /health
```

Response:
```json
{
  "status": "ok",
  "connected": true,
  "last_qr": "2024-01-15T10:30:00.000Z",
  "uptime": 3600,
  "reconnect_attempts": 0,
  "last_connection": "2024-01-15T10:30:00.000Z",
  "telegram_configured": true,
  "self_ping_enabled": true,
  "presence_updates_active": true,
  "user": {
    "id": "919876543210",
    "name": "John Doe"
  }
}
```

#### 2. **Send Message**
```bash
POST /send
Headers:
  auth-key: your-secret-api-key
  Content-Type: application/json

Body (text):
{
  "jid": "919876543210@s.whatsapp.net",
  "message": "Hello from API!"
}

Body (with image):
{
  "jid": "919876543210@s.whatsapp.net",
  "message": "Check this out!",
  "file": "<base64-encoded-image>",
  "filename": "photo.jpg",
  "mimetype": "image/jpeg"
}
```

Response:
```json
{
  "ok": true,
  "message_id": "3EB0ABC123DEF456",
  "raw": { ... }
}
```

#### 4. **Get Media File**
```bash
GET /media/:uniqueId
Headers:
  auth-key: your-secret-api-key
```

Example:
```bash
GET /media/MEDIA_1234567890_abcdef123456
Headers:
  auth-key: your-secret-api-key
```

Response:
- Success: Binary file data with appropriate Content-Type header
- Error: `{ "success": false, "error": "Media not found" }`

**How it works:**
1. When a media message is received, it's uploaded to Telegram
2. `media_unique_id` and `telegram_file_id` are stored in database
3. Use this endpoint to retrieve the original file from Telegram
4. File is downloaded from Telegram and streamed to client

#### 5. **Webhook Test**
```bash
POST /webhook-test
Headers:
  auth-key: your-secret-api-key
  Content-Type: application/json

Body:
{
  "message_id": "test123",
  "jid": "919876543210@s.whatsapp.net",
  "phone_no": "919876543210",
  "display_name": "Test User",
  "type": "conversation",
  "text": "Test message",
  "from_me": false,
  "received_at": "2024-01-15T10:30:00.000Z"
}
```

#### 6. **Clear Session** (force logout)
```bash
POST /clear-session
Headers:
  auth-key: your-secret-api-key
```

## 📤 Webhook Forwarding

All incoming messages are automatically forwarded to configured webhooks with this payload:

```json
{
  "message_id": "3EB0ABC123",
  "jid": "919876543210@s.whatsapp.net",
  "phone_no": "919876543210",
  "display_name": "John Doe",
  "type": "imageMessage",
  "text": "My new car!",
  "media_unique_id": "MEDIA_1234567890_abcdef123456",
  "telegram_message_id": "12345",
  "telegram_file_id": "AgACAgIAAxkBAAIBCD...",
  "media_mimetype": "image/jpeg",
  "media_filename": "IMG-20240115-WA0001.jpg",
  "media_size": 245760,
  "from_me": false,
  "received_at": "2024-01-15T14:30:45.000Z",
  "is_reply": false,
  "reply_to_message_id": null,
  "reply_to_text": null,
  "reaction_text": null
}
```

**Important Notes:**
- Media files are **NOT** sent as base64 in webhooks (they're stored in Telegram)
- Use `media_unique_id` to retrieve media via `/media/:uniqueId` endpoint
- Outgoing messages (sent by you) are **NOT** forwarded to webhooks
- Only incoming messages are forwarded

### Retry Logic
- 3 retry attempts per webhook
- Exponential backoff: 2s, 5s, 10s
- Errors are logged but don't block message processing

## 🔄 Reconnection Strategies

The server handles all WhatsApp disconnect scenarios:

| Reason | Strategy |
|--------|----------|
| `loggedOut` | Clear session, generate new QR |
| `badSession` | Clear corrupted session, restart |
| `connectionClosed` | Reconnect with exponential backoff |
| `connectionLost` | Reconnect with exponential backoff |
| `timedOut` | Reconnect with exponential backoff |
| `restartRequired` | Immediate restart |

**Backoff delays:** 5s, 10s, 15s, 20s, 25s, 30s (max)  
**Max attempts:** 10 before manual intervention required

## 📊 Message Types Supported

- ✅ Text messages (`conversation`, `extendedTextMessage`)
- ✅ Images (`imageMessage`)
- ✅ Videos (`videoMessage`)
- ✅ Audio (`audioMessage`)
- ✅ Documents (`documentMessage`)
- ✅ Stickers (`stickerMessage`)
- ✅ Reactions (`reactionMessage`)
- ✅ Replies (context detection)

## 🔒 Security

- **Rate limiting:** 10 requests/minute per IP on `/send`
- **Auth header required:** All protected endpoints require `auth-key` header
- **Input validation:** JID format, file size limits (50MB for media)
- **No credential exposure:** All secrets in environment variables
- **Telegram storage:** Media files stored securely in Telegram (not in Supabase)
- **Unique media IDs:** Prevents duplicate media uploads

## 📈 Monitoring

All connection events are logged to `connection_logs` table:

```sql
SELECT * FROM connection_logs 
ORDER BY timestamp DESC 
LIMIT 10;
```

View all messages with media info:
```sql
SELECT 
  display_name, 
  type, 
  text, 
  direction, 
  from_me,
  media_unique_id,
  telegram_file_id,
  created_at 
FROM messages 
ORDER BY created_at DESC 
LIMIT 50;
```

View media messages only:
```sql
SELECT 
  display_name,
  media_filename,
  media_mimetype,
  media_size,
  media_unique_id,
  telegram_message_id,
  created_at
FROM messages
WHERE media_unique_id IS NOT NULL
ORDER BY created_at DESC;
```

Check auth data (session files):
```sql
SELECT 
  session_id,
  file_name,
  updated_at
FROM auth_data
ORDER BY updated_at DESC;
```

## 🧪 Testing

### Manual Acceptance Tests

1. **QR Code Flow**
   - Start server with clean Supabase (no existing session in `auth_data`)
   - Visit `/qr` and verify QR PNG displays
   - Scan with WhatsApp and confirm connection
   - Verify page switches to "Connected" state
   - Check `auth_data` table for session files (creds.json, app-state-sync-key-*.json)

2. **Incoming Messages**
   - Send text message to bot
   - Verify message in `messages` table with `from_me=false` and `direction='inbound'`
   - Verify webhook received payload (if configured)
   - Send image with caption
   - Verify media uploaded to Telegram
   - Check `media_unique_id`, `telegram_message_id`, and `telegram_file_id` are populated
   - Verify media can be retrieved via `/media/:uniqueId` endpoint

3. **Outgoing Messages**
   - Call `/send` with text
   - Verify message delivered on WhatsApp
   - Verify message stored in `messages` table with `from_me=true` and `direction='outbound'`
   - Verify webhook does NOT receive this message
   - Call `/send` with base64 image
   - Verify image sent and stored in database

4. **Reconnection**
   - Simulate network drop (disable WiFi)
   - Verify automatic reconnection with backoff
   - Call `/clear-session`
   - Verify `auth_data` table is cleared
   - Verify new QR generated

5. **Telegram Media Storage**
   - Send image/video to bot
   - Check Telegram bot chat for uploaded media
   - Verify caption contains metadata (sender, phone, type, size, etc.)
   - Retrieve media using `/media/:uniqueId` endpoint
   - Verify media matches original

6. **Self-Ping & Presence**
   - Check logs for "🏓 PING" messages every 4 minutes
   - Verify bot appears "online" in WhatsApp
   - Check logs for "👁️ PRESENCE" updates every 30 seconds

## 🐛 Troubleshooting

**Issue:** QR not showing  
**Solution:** Check console logs, ensure Supabase credentials are correct, verify `auth_data` table exists

**Issue:** Messages not forwarding  
**Solution:** Verify `N8N_WEBHOOKS` is set correctly, check webhook endpoint logs

**Issue:** "Bot not connected" error  
**Solution:** Visit `/health` to check connection status, rescan QR if needed

**Issue:** Session keeps logging out  
**Solution:** Clear session via `/clear-session`, ensure stable internet connection, check `auth_data` table integrity

**Issue:** Media not uploading to Telegram  
**Solution:** Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct, check Telegram bot is not blocked, ensure bot can send messages to the chat

**Issue:** Self-ping not working  
**Solution:** Check `SELF_PING_ENABLED=true` in .env, verify `SELF_PING_URL` is accessible, check logs for ping errors

**Issue:** Bot not showing online  
**Solution:** Check logs for presence updates, verify connection is stable, restart server if needed

**Issue:** Media retrieval fails  
**Solution:** Check `telegram_file_id` exists in database, verify Telegram bot token is valid, ensure media wasn't deleted from Telegram

## 🎯 Key Differences from Standard Setup

### 1. **Media Storage Strategy**
- **Old:** Base64 in Supabase (large database, slow queries)
- **New:** Telegram bot storage (unlimited, fast, free)

### 2. **Session Management**
- **Old:** `sessions` table with JSONB
- **New:** `auth_data` table with individual files (more reliable)

### 3. **Message Tracking**
- **Old:** Only incoming messages
- **New:** Both incoming AND outgoing messages (complete history)

### 4. **Webhook Behavior**
- **Old:** All messages forwarded
- **New:** Only incoming messages forwarded (prevents loops)

### 5. **Uptime Management**
- **New:** Self-ping mechanism for free hosting platforms (Render, Railway, etc.)
- **New:** Always online presence updates

### 6. **Read Receipts**
- **New:** Blue ticks enabled for all messages automatically

## 🚀 Deployment Tips

### Render.com
1. Set `SELF_PING_ENABLED=true`
2. Set `SELF_PING_URL=https://your-app.onrender.com/health`
3. Free tier sleeps after 15 minutes - self-ping keeps it alive

### Railway.app
1. Same as Render
2. Set `PORT` environment variable (Railway provides it automatically)

### Heroku
1. Enable self-ping
2. Use hobby dyno to avoid sleep (free dyno deprecated)

### VPS (DigitalOcean, AWS, etc.)
1. Can disable self-ping (`SELF_PING_ENABLED=false`)
2. Set up PM2 for process management:
   ```bash
   npm install -g pm2
   pm2 start wa-api.js --name whatsapp-api
   pm2 startup
   pm2 save
   ```

## 📊 Database Schema Summary

### `auth_data` Table
- Stores WhatsApp session authentication files
- Each file (creds.json, keys) stored as separate row
- Automatically updated on credential changes

### `messages` Table
- Stores all incoming and outgoing messages
- Media references stored (not actual files)
- Telegram integration for media retrieval
- Supports replies, reactions, and all message types

### `connection_logs` Table
- Monitors connection events and reconnection attempts
- Useful for debugging connection issues
- Tracks event types, status codes, and timestamps

## 🎨 Features Summary

### ✅ What This Bot Does
- **Receives ALL incoming messages** (text, media, reactions, replies)
- **Stores ALL outgoing messages** (messages you send)
- **Forwards incoming messages to webhooks** (not outgoing)
- **Uploads media to Telegram** (unlimited free storage)
- **Always appears online** (presence updates every 30s)
- **Sends blue ticks** (read receipts for all messages)
- **Auto-reconnects** on disconnection (smart backoff)
- **Self-pings** to prevent sleep on free hosting
- **Web-based QR scanning** (no terminal required)
- **Complete message history** (both directions in database)

### ❌ What This Bot Does NOT Do
- Does NOT forward your outgoing messages to webhooks (prevents loops)
- Does NOT store media files in Supabase (uses Telegram instead)
- Does NOT require local file storage (everything in cloud)
- Does NOT expose credentials (all in environment variables)

## 📞 Getting Help

### Debug Checklist
1. ✅ Check `/health` endpoint - is bot connected?
2. ✅ View console logs - colorful emojified output
3. ✅ Check Supabase tables - are messages being stored?
4. ✅ Verify Telegram - are media files uploading?
5. ✅ Test webhooks - are they receiving payloads?

### Common Log Messages
- `🚀 CONNECT` - Bot connected successfully
- `🔌 DISCONN` - Bot disconnected (will auto-reconnect)
- `💬 MESSAGE` - Message received/sent
- `📤 TELEGRAM` - Media uploaded to Telegram
- `🔔 WEBHOOK` - Message forwarded to webhook
- `💾 DATABASE` - Data saved to Supabase
- `🏓 PING` - Self-ping executed
- `👁️ PRESENCE` - Online status updated

## 📝 License

MIT

## 🤝 Support

For issues and questions, check the console logs first. All operations are logged with timestamps and severity levels.

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     WhatsApp API Server                      │
│                        (wa-api.js)                          │
└────────┬────────────────────────────────────────────┬───────┘
         │                                             │
         ▼                                             ▼
┌────────────────┐                            ┌────────────────┐
│   WhatsApp     │◄───── Baileys ──────────►│    Express     │
│   Connection   │      (WebSocket)          │   Web Server   │
└────────┬───────┘                           └────────┬───────┘
         │                                            │
         │                                            │
         ▼                                            ▼
┌────────────────────────────────────────────────────────────┐
│                    Storage Layer                           │
├───────────────────┬──────────────────┬─────────────────────┤
│   Supabase DB     │   Telegram Bot   │   N8N Webhooks     │
│   - auth_data     │   - Media Files  │   - Forward Msgs   │
│   - messages      │   - Unlimited    │   - Retry Logic    │
│   - conn_logs     │   - Free Storage │   - Async          │
└───────────────────┴──────────────────┴─────────────────────┘
```

### Data Flow

**Incoming Message:**
1. WhatsApp → Baileys → Message Handler
2. If media: Download → Upload to Telegram → Get file_id
3. Save to Supabase (messages table) with telegram_file_id
4. Forward to N8N webhooks (async)
5. Send blue tick (read receipt)

**Outgoing Message:**
1. POST /send → Validate → Send via Baileys
2. Save to Supabase (from_me=true, direction=outbound)
3. NOT forwarded to webhooks

**Media Retrieval:**
1. GET /media/:uniqueId
2. Query Supabase for telegram_file_id
3. Download from Telegram
4. Stream to client

---

**Made with ❤️ using Baileys, Supabase, and Telegram**
