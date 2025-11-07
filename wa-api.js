/**
 * ============================================
 * 🚀 WhatsApp API Server - Enhanced Version
 * ============================================
 * 
 * NEW FEATURES:
 * ✅ Self-ping to prevent sleep
 * ✅ Forward ALL incoming messages (no skips)
 * ✅ Store ALL outgoing messages (own messages)
 * ✅ Blue tick (read receipts) for ALL messages
 * ✅ Always show online status
 * ✅ Telegram media storage
 * 
 * ============================================
 */

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const chalk = require('chalk');
const crypto = require('crypto');
const FormData = require('form-data');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  initAuthCreds,
  BufferJSON,
  proto,
  Browsers,
  downloadMediaMessage,
  getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  authKey: process.env.AUTH_KEY,
  sessionId: process.env.SESSION_ID || 'default',
  n8nWebhooks: process.env.N8N_WEBHOOKS ? process.env.N8N_WEBHOOKS.split(',').map(u => u.trim()) : [],
  
  // Telegram Configuration
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  
  port: parseInt(process.env.PORT || '5000'),
  qrPollInterval: parseInt(process.env.QR_POLL_INTERVAL_MS || '3000'),
  maxMediaSize: parseInt(process.env.MAX_MEDIA_SIZE || '52428800'), // 50MB default
  maxReconnectAttempts: 10,
  maxBackoffDelay: 30000,
  webhookRetries: 3,
  webhookRetryDelays: [2000, 5000, 10000],
  
  // NEW: Self-ping configuration
  selfPingEnabled: process.env.SELF_PING_ENABLED !== 'false', // Default: true
  selfPingInterval: parseInt(process.env.SELF_PING_INTERVAL_MS || '240000'), // 4 minutes default
  selfPingUrl: process.env.SELF_PING_URL || null, // Auto-detect if not set
  
  // NEW: Online presence configuration
  presenceUpdateInterval: parseInt(process.env.PRESENCE_UPDATE_INTERVAL_MS || '30000'), // 30 seconds
};

// Validate required config
if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey || !CONFIG.authKey) {
  console.error('❌ Missing required env vars: SUPABASE_URL, SUPABASE_KEY, AUTH_KEY');
  process.exit(1);
}

if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
  console.error('❌ Missing required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
  process.exit(1);
}

// ============================================
// GLOBAL STATE
// ============================================
const STATE = {
  sock: null,
  authState: null,
  currentQR: null,
  currentQRString: null,
  isConnected: false,
  connectedUser: null,
  reconnectAttempts: 0,
  reconnectTimeout: null,
  lastQRTimestamp: null,
  messageQueue: [],
  processingQueue: false,
  lastSuccessfulConnection: null,
  selfPingInterval: null, // NEW
  presenceInterval: null, // NEW
};

// ============================================
// LOGGER - Colorful & Emojified
// ============================================
const getTime = () => {
  const now = new Date();
  return chalk.gray(`${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`);
};

const logger = {
  info: (msg) => console.log(`${getTime()} ${chalk.blue('ℹ️  INFO')}    ${msg}`),
  success: (msg) => console.log(`${getTime()} ${chalk.green('✅ SUCCESS')} ${msg}`),
  warn: (msg) => console.log(`${getTime()} ${chalk.yellow('⚠️  WARN')}    ${msg}`),
  error: (msg) => console.log(`${getTime()} ${chalk.red('❌ ERROR')}   ${msg}`),
  webhook: (msg) => console.log(`${getTime()} ${chalk.magenta('🔔 WEBHOOK')} ${msg}`),
  db: (msg) => console.log(`${getTime()} ${chalk.cyan('💾 DATABASE')} ${msg}`),
  qr: (msg) => console.log(`${getTime()} ${chalk.blue('📱 QR CODE')} ${msg}`),
  connect: (msg) => console.log(`${getTime()} ${chalk.green.bold('🚀 CONNECT')} ${chalk.green(msg)}`),
  disconnect: (msg) => console.log(`${getTime()} ${chalk.red('🔌 DISCONN')} ${msg}`),
  message: (msg) => console.log(`${getTime()} ${chalk.cyan('💬 MESSAGE')} ${msg}`),
  telegram: (msg) => console.log(`${getTime()} ${chalk.blueBright('📤 TELEGRAM')} ${msg}`),
  ping: (msg) => console.log(`${getTime()} ${chalk.magenta('🏓 PING')}    ${msg}`), // NEW
  presence: (msg) => console.log(`${getTime()} ${chalk.green('👁️  PRESENCE')} ${msg}`), // NEW
  line: () => console.log(chalk.gray('━'.repeat(80))),
  banner: (msg) => {
    console.log(chalk.gray('━'.repeat(80)));
    console.log(chalk.bold.cyan(`  ${msg}`));
    console.log(chalk.gray('━'.repeat(80)));
  }
};

// ============================================
// SUPABASE CLIENT (Custom HTTP-based)
// ============================================
class SupabaseClient {
  constructor(url, key) {
    this.url = url;
    this.key = key;
    this.headers = {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
  }

  async query(table, method = 'GET', params = {}, body = null) {
    try {
      const url = new URL(`${this.url}/rest/v1/${table}`);
      
      if (params.select) url.searchParams.append('select', params.select);
      if (params.eq) {
        Object.entries(params.eq).forEach(([key, value]) => {
          url.searchParams.append(key, `eq.${value}`);
        });
      }
      if (params.limit) url.searchParams.append('limit', params.limit);
      if (params.single) this.headers['Accept'] = 'application/vnd.pgrst.object+json';

      const config = {
        method,
        headers: { ...this.headers },
        timeout: 10000
      };

      if (body) config.data = body;

      const response = await axios({ url: url.toString(), ...config });
      return { data: response.data, error: null };
    } catch (error) {
      if (error.response?.status === 406) {
        return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
      }
      return { data: null, error: { message: error.message, details: error.response?.data } };
    }
  }

  async insert(table, data) {
    return this.query(table, 'POST', {}, Array.isArray(data) ? data : [data]);
  }

  async upsert(table, data, conflict) {
    const url = `${this.url}/rest/v1/${table}`;
    try {
      const response = await axios.post(url, Array.isArray(data) ? data : [data], {
        headers: {
          ...this.headers,
          'Prefer': `resolution=merge-duplicates,return=representation`
        },
        timeout: 10000
      });
      return { data: response.data, error: null };
    } catch (error) {
      return { data: null, error: { message: error.message } };
    }
  }

  async update(table, data, match) {
    const url = new URL(`${this.url}/rest/v1/${table}`);
    Object.entries(match).forEach(([key, value]) => {
      url.searchParams.append(key, `eq.${value}`);
    });

    try {
      const response = await axios.patch(url.toString(), data, {
        headers: this.headers,
        timeout: 10000
      });
      return { data: response.data, error: null };
    } catch (error) {
      return { data: null, error: { message: error.message } };
    }
  }

  async delete(table, match) {
    const url = new URL(`${this.url}/rest/v1/${table}`);
    Object.entries(match).forEach(([key, value]) => {
      url.searchParams.append(key, `eq.${value}`);
    });

    try {
      await axios.delete(url.toString(), { headers: this.headers, timeout: 10000 });
      return { error: null };
    } catch (error) {
      return { error: { message: error.message } };
    }
  }
}

const supabase = new SupabaseClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

// ============================================
// UTILITIES
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const extractPlainPhone = (jid) => {
  if (!jid || typeof jid !== 'string') return null;
  return jid.split('@')[0].replace(/[^0-9]/g, '') || null;
};

const isPersonalChat = (jid) => jid && jid.endsWith('@s.whatsapp.net');

const addJitter = (ms) => {
  const jitter = Math.random() * 1000;
  return ms + jitter;
};

// Generate unique media ID
const generateMediaId = () => {
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  return `MEDIA_${timestamp}_${random}`;
};

// Write queue to prevent concurrent writes
const writeQueue = new Map();
const queueWrite = async (key, writeFunction) => {
  while (writeQueue.has(key)) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  writeQueue.set(key, true);
  
  try {
    const result = await writeFunction();
    return result;
  } finally {
    writeQueue.delete(key);
  }
};

// ============================================
// NEW: SELF-PING MECHANISM
// ============================================
const startSelfPing = () => {
  if (!CONFIG.selfPingEnabled) {
    logger.info('Self-ping disabled');
    return;
  }

  // Auto-detect URL if not provided
  const pingUrl = CONFIG.selfPingUrl || `http://localhost:${CONFIG.port}/health`;
  
  logger.success(`🏓 Self-ping enabled: ${chalk.yellow(pingUrl)} every ${chalk.cyan(CONFIG.selfPingInterval / 1000)}s`);
  
  STATE.selfPingInterval = setInterval(async () => {
    try {
      const response = await axios.get(pingUrl, { timeout: 5000 });
      logger.ping(`✓ Ping successful - Status: ${response.data.status}, Connected: ${response.data.connected}`);
    } catch (err) {
      logger.warn(`Ping failed: ${err.message}`);
    }
  }, CONFIG.selfPingInterval);
};

const stopSelfPing = () => {
  if (STATE.selfPingInterval) {
    clearInterval(STATE.selfPingInterval);
    STATE.selfPingInterval = null;
    logger.info('Self-ping stopped');
  }
};

// ============================================
// NEW: ALWAYS ONLINE PRESENCE
// ============================================
const startPresenceUpdates = () => {
  if (!STATE.sock || !STATE.isConnected) {
    logger.warn('Cannot start presence updates - not connected');
    return;
  }

  logger.success(`👁️  Online presence enabled - updating every ${chalk.cyan(CONFIG.presenceUpdateInterval / 1000)}s`);
  
  // Send initial presence
  updatePresence();
  
  // Set interval for updates
  STATE.presenceInterval = setInterval(() => {
    updatePresence();
  }, CONFIG.presenceUpdateInterval);
};

const updatePresence = async () => {
  if (!STATE.sock || !STATE.isConnected) return;
  
  try {
    await STATE.sock.sendPresenceUpdate('available');
    logger.presence('Status updated to "available" (online)');
  } catch (err) {
    logger.warn(`Presence update failed: ${err.message}`);
  }
};

const stopPresenceUpdates = () => {
  if (STATE.presenceInterval) {
    clearInterval(STATE.presenceInterval);
    STATE.presenceInterval = null;
    logger.info('Presence updates stopped');
  }
};

// ============================================
// TELEGRAM FUNCTIONS
// ============================================

/**
 * Send media file to Telegram with metadata
 */
const sendMediaToTelegram = async (mediaBuffer, metadata) => {
  try {
    const {
      uniqueId,
      filename,
      mimetype,
      size,
      senderJid,
      senderPhone,
      senderName,
      messageType,
      timestamp,
      isReply,
      replyToMessageId,
      replyToText,
      fromMe // NEW
    } = metadata;

    logger.telegram(`Uploading ${filename} (${(size / 1024).toFixed(2)} KB) to Telegram...`);

    // Build caption with all metadata
    let caption = `📎 **Media File**\n\n`;
    caption += `🆔 **Unique ID:** \`${uniqueId}\`\n`;
    caption += `👤 **Sender:** ${senderName}\n`;
    caption += `📱 **Phone:** ${senderPhone}\n`;
    caption += `📧 **JID:** \`${senderJid}\`\n`;
    caption += `📝 **Type:** ${messageType}\n`;
    caption += `📏 **Size:** ${(size / 1024).toFixed(2)} KB\n`;
    caption += `🕐 **Received:** ${new Date(timestamp).toLocaleString()}\n`;
    caption += `📍 **Direction:** ${fromMe ? 'Outbound (Sent)' : 'Inbound (Received)'}\n`; // NEW
    
    if (isReply) {
      caption += `\n↩️ **Reply to:** ${replyToMessageId}\n`;
      if (replyToText) {
        caption += `💬 **Original:** ${replyToText.substring(0, 100)}${replyToText.length > 100 ? '...' : ''}\n`;
      }
    }

    const form = new FormData();
    form.append('chat_id', CONFIG.telegramChatId);
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');

    // Determine media type and send accordingly
    const mediaTypeCategory = mimetype.split('/')[0];
    
    if (mediaTypeCategory === 'image') {
      form.append('photo', mediaBuffer, { filename });
      var telegramUrl = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendPhoto`;
    } else if (mediaTypeCategory === 'video') {
      form.append('video', mediaBuffer, { filename });
      var telegramUrl = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendVideo`;
    } else if (mediaTypeCategory === 'audio') {
      form.append('audio', mediaBuffer, { filename });
      var telegramUrl = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendAudio`;
    } else {
      form.append('document', mediaBuffer, { filename });
      var telegramUrl = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendDocument`;
    }

    const response = await axios.post(telegramUrl, form, {
      headers: {
        ...form.getHeaders()
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    if (!response.data.ok) {
      throw new Error(`Telegram API error: ${response.data.description}`);
    }

    const result = response.data.result;
    
    let fileId = null;
    if (result.photo) {
      fileId = result.photo[result.photo.length - 1].file_id;
    } else if (result.video) {
      fileId = result.video.file_id;
    } else if (result.audio) {
      fileId = result.audio.file_id;
    } else if (result.document) {
      fileId = result.document.file_id;
    }

    logger.success(`✓ Uploaded to Telegram - Message ID: ${result.message_id}, File ID: ${fileId}`);

    return {
      success: true,
      telegramMessageId: result.message_id.toString(),
      telegramFileId: fileId,
      chatId: result.chat.id.toString()
    };

  } catch (err) {
    logger.error(`Telegram upload failed: ${err.message}`);
    
    return {
      success: false,
      error: err.message,
      telegramMessageId: null,
      telegramFileId: null
    };
  }
};

/**
 * Retrieve media from Telegram by file_id
 */
const getMediaFromTelegram = async (fileId) => {
  try {
    const fileInfoUrl = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/getFile?file_id=${fileId}`;
    const fileInfoResponse = await axios.get(fileInfoUrl);
    
    if (!fileInfoResponse.data.ok) {
      throw new Error('Failed to get file info from Telegram');
    }

    const filePath = fileInfoResponse.data.result.file_path;
    
    const fileUrl = `https://api.telegram.org/file/bot${CONFIG.telegramBotToken}/${filePath}`;
    const fileResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    
    return Buffer.from(fileResponse.data);
  } catch (err) {
    logger.error(`Failed to retrieve from Telegram: ${err.message}`);
    throw err;
  }
};

// ============================================
// SUPABASE AUTH STATE
// ============================================
const useSupabaseAuthState = async () => {
  logger.db('Loading auth state from Supabase...');

  const fixFileName = (file) => file.replace(/\//g, '__').replace(/:/g, '-').replace(/\./g, '_');

  const writeData = async (file, data) => {
    return queueWrite(`${CONFIG.sessionId}:${file}`, async () => {
      const maxRetries = 3;
      let attempt = 0;
      
      while (attempt < maxRetries) {
        try {
          attempt++;
          
          if (!data || typeof data !== 'object') {
            throw new Error('Invalid data structure');
          }
        
        const jsonData = JSON.stringify(data, BufferJSON.replacer);
        
        if (!jsonData || jsonData === 'null' || jsonData === '{}') {
          throw new Error('Serialization produced invalid data');
        }
        
        try {
          JSON.parse(jsonData, BufferJSON.reviver);
        } catch (parseErr) {
          throw new Error(`Data validation failed: ${parseErr.message}`);
        }
        
        const fileName = fixFileName(file);
        const backupName = `${fileName}.backup`;
        
        const { data: existing } = await supabase.query('auth_data', 'GET', {
          select: 'file_data',
          eq: { session_id: CONFIG.sessionId, file_name: fileName },
          single: true
        });
        
        if (existing?.file_data) {
          await supabase.upsert('auth_data', {
            session_id: CONFIG.sessionId,
            file_name: backupName,
            file_data: existing.file_data,
            updated_at: new Date().toISOString()
          });
        }
        
        const payload = {
          session_id: CONFIG.sessionId,
          file_name: fileName,
          file_data: jsonData,
          updated_at: new Date().toISOString()
        };

        const { error } = await supabase.upsert('auth_data', payload);
        if (error) throw new Error(error.message);
        
        const { data: verified } = await supabase.query('auth_data', 'GET', {
          select: 'file_data',
          eq: { session_id: CONFIG.sessionId, file_name: fileName },
          single: true
        });
        
        if (!verified?.file_data) {
          throw new Error('Write verification failed - data not found');
        }
        
        try {
          JSON.parse(verified.file_data, BufferJSON.reviver);
        } catch {
          throw new Error('Write verification failed - data corrupted');
        }
        
        if (file === 'creds.json') {
          logger.db(`✓ Credentials saved to Supabase ${chalk.gray('(atomic)')}`);
        }
        
        return true;
      } catch (err) {
        logger.warn(`Write attempt ${attempt}/${maxRetries} failed for ${file}: ${err.message}`);
        
        if (attempt >= maxRetries) {
          logger.error(`Failed to write ${file} after ${maxRetries} attempts`);
          return false;
        }
        
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
    
    return false;
    });
  };

  const readData = async (file) => {
    try {
      const fileName = fixFileName(file);
      const backupName = `${fileName}.backup`;
      
      const { data, error } = await supabase.query('auth_data', 'GET', {
        select: 'file_data',
        eq: { 
          session_id: CONFIG.sessionId,
          file_name: fileName
        },
        single: true
      });

      if (error && error.code !== 'PGRST116') throw new Error(error.message);
      
      if (!data || !data.file_data) {
        const { data: backup } = await supabase.query('auth_data', 'GET', {
          select: 'file_data',
          eq: { session_id: CONFIG.sessionId, file_name: backupName },
          single: true
        });
        
        if (backup?.file_data) {
          logger.warn(`${chalk.yellow('Primary missing')} ${file} - restored from backup`);
          await supabase.upsert('auth_data', {
            session_id: CONFIG.sessionId,
            file_name: fileName,
            file_data: backup.file_data,
            updated_at: new Date().toISOString()
          });
          return JSON.parse(backup.file_data, BufferJSON.reviver);
        }
        
        return null;
      }
      
      try {
        return JSON.parse(data.file_data, BufferJSON.reviver);
      } catch (parseErr) {
        logger.warn(`${chalk.yellow('Corrupted')} ${file} - trying backup`);
        
        const { data: backup } = await supabase.query('auth_data', 'GET', {
          select: 'file_data',
          eq: { session_id: CONFIG.sessionId, file_name: backupName },
          single: true
        });
        
        if (backup?.file_data) {
          try {
            const recoveredData = JSON.parse(backup.file_data, BufferJSON.reviver);
            logger.success(`${chalk.green('Recovered')} ${file} from backup`);
            
            await supabase.upsert('auth_data', {
              session_id: CONFIG.sessionId,
              file_name: fileName,
              file_data: backup.file_data,
              updated_at: new Date().toISOString()
            });
            
            return recoveredData;
          } catch {
            logger.warn(`${chalk.yellow('Backup also corrupted')} ${file}`);
          }
        }
        
        logger.warn(`${chalk.yellow('Attempting salvage')} ${file}`);
        try {
          return JSON.parse(data.file_data);
        } catch {
          logger.error(`${chalk.red('Unrecoverable')} ${file}`);
          return null;
        }
      }
    } catch (err) {
      if (!err.message.includes('PGRST116')) {
        logger.error(`Failed to read ${file}: ${err.message}`);
      }
      return null;
    }
  };

  const removeData = async (file) => {
    try {
      await supabase.delete('auth_data', { 
        session_id: CONFIG.sessionId,
        file_name: fixFileName(file)
      });
    } catch (err) {
      logger.error(`Failed to remove ${file}: ${err.message}`);
    }
  };

  let creds = await readData('creds.json');
  
  if (!creds) {
    logger.warn('No existing credentials - initializing new session');
    creds = initAuthCreds();
    await writeData('creds.json', creds);
  } else {
    if (!creds.noiseKey || !creds.signedIdentityKey || !creds.signedPreKey) {
      logger.warn(`${chalk.yellow('Incomplete credentials')} - attempting to repair`);
      const newCreds = initAuthCreds();
      creds.noiseKey = creds.noiseKey || newCreds.noiseKey;
      creds.signedIdentityKey = creds.signedIdentityKey || newCreds.signedIdentityKey;
      creds.signedPreKey = creds.signedPreKey || newCreds.signedPreKey;
      creds.advSecretKey = creds.advSecretKey || newCreds.advSecretKey;
      await writeData('creds.json', creds);
      logger.info('Credentials repaired - attempting to use');
    } else {
      logger.success(`Credentials loaded - ID: ${creds?.me?.id || 'new'}`);
    }
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const operations = [];
          
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              operations.push({ file, value, isDelete: !value });
            }
          }
          
          const batchSize = 5;
          for (let i = 0; i < operations.length; i += batchSize) {
            const batch = operations.slice(i, i + batchSize);
            const batchTasks = batch.map(op => 
              op.isDelete ? removeData(op.file) : writeData(op.file, op.value)
            );
            
            try {
              await Promise.all(batchTasks);
              if (i + batchSize < operations.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            } catch (err) {
              logger.error(`Batch write error: ${err.message}`);
            }
          }
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds.json', creds);
    }
  };
};

// ============================================
// DATABASE FUNCTIONS
// ============================================
const logConnectionEvent = async (eventType, statusCode, reason, attemptNumber) => {
  try {
    await supabase.insert('connection_logs', {
      event_type: eventType,
      status_code: statusCode,
      reason: reason,
      attempt_number: attemptNumber,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error(`Failed to log connection event: ${err.message}`);
  }
};

const saveMessageToSupabase = async (messageData) => {
  try {
    const { error } = await supabase.insert('messages', messageData);
    if (error) {
      logger.error(`DB save error: ${error.message}`);
      return false;
    }
    logger.db(`Message saved: ${messageData.type} (${messageData.direction}) ${messageData.from_me ? '[OUTGOING]' : '[INCOMING]'} ${messageData.media_unique_id ? `[Media: ${messageData.media_unique_id}]` : ''}`);
    return true;
  } catch (err) {
    logger.error(`DB failed: ${err.message}`);
    return false;
  }
};

// ============================================
// MEDIA HANDLING - UPDATED FOR TELEGRAM
// ============================================
const downloadAndSendToTelegram = async (msg, messageType, metadata) => {
  try {
    const messageContent = msg.message[messageType];
    const fileSize = parseInt(messageContent?.fileLength || 0);
    
    if (fileSize > CONFIG.maxMediaSize) {
      logger.warn(`Media too large: ${(fileSize / 1024 / 1024).toFixed(2)}MB (max ${CONFIG.maxMediaSize / 1024 / 1024}MB)`);
      return null;
    }

    logger.info(`Downloading ${messageType}...`);
    
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: STATE.sock?.updateMediaMessage
    });

    if (!buffer || buffer.length === 0) return null;

    const mimetype = messageContent?.mimetype || 'application/octet-stream';
    let ext = mimetype.includes('/') ? mimetype.split('/')[1].split(';')[0] : 'bin';
    let filename = messageContent?.fileName || `${messageType.replace('Message', '')}_${Date.now()}.${ext}`;
    
    logger.success(`✓ Downloaded ${filename} (${(buffer.length / 1024).toFixed(2)} KB)`);

    const uniqueId = generateMediaId();

    const telegramMetadata = {
      uniqueId,
      filename,
      mimetype,
      size: buffer.length,
      ...metadata
    };

    const telegramResult = await sendMediaToTelegram(buffer, telegramMetadata);

    return {
      uniqueId,
      mimetype,
      filename,
      size: buffer.length,
      telegramMessageId: telegramResult.telegramMessageId,
      telegramFileId: telegramResult.telegramFileId,
      telegramSuccess: telegramResult.success
    };
  } catch (err) {
    logger.error(`Media download/upload error: ${err.message}`);
    return null;
  }
};

// ============================================
// MESSAGE EXTRACTION - UPDATED
// ============================================
const extractMessageData = async (msg) => {
  try {
    const messageType = getContentType(msg.message);
    if (!messageType) return null;

    const messageContent = msg.message[messageType];
    
    let data = {
      text: null,
      media_unique_id: null,
      telegram_message_id: null,
      telegram_file_id: null,
      media_mimetype: null,
      media_filename: null,
      media_size: null,
      reaction_text: null,
      is_reply: false,
      reply_to_message_id: null,
      reply_to_text: null
    };

    // Check for reply
    if (messageContent?.contextInfo?.stanzaId || messageContent?.contextInfo?.quotedMessage) {
      data.is_reply = true;
      data.reply_to_message_id = messageContent.contextInfo.stanzaId || null;
      
      if (messageContent.contextInfo.quotedMessage) {
        const quotedType = getContentType(messageContent.contextInfo.quotedMessage);
        const quotedContent = messageContent.contextInfo.quotedMessage[quotedType];
        data.reply_to_text = quotedContent?.text || quotedContent?.caption || JSON.stringify(quotedContent).substring(0, 100);
      }
    }

    // Prepare metadata for media files
    const senderJid = msg.key.remoteJid;
    const senderPhone = extractPlainPhone(senderJid);
    const senderName = msg.pushName || senderPhone || 'Unknown';
    const timestamp = new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString();
    const fromMe = msg.key.fromMe || false; // NEW

    // Process by type
    switch (messageType) {
      case 'conversation':
        data.text = messageContent;
        break;

      case 'extendedTextMessage':
        data.text = messageContent.text;
        break;

      case 'imageMessage':
      case 'videoMessage':
      case 'audioMessage':
      case 'documentMessage':
      case 'stickerMessage':
        data.text = messageContent.caption || `[${messageType.replace('Message', '')}]`;
        
        const mediaResult = await downloadAndSendToTelegram(msg, messageType, {
          senderJid,
          senderPhone,
          senderName,
          messageType,
          timestamp,
          isReply: data.is_reply,
          replyToMessageId: data.reply_to_message_id,
          replyToText: data.reply_to_text,
          fromMe // NEW
        });
        
        if (mediaResult) {
          data.media_unique_id = mediaResult.uniqueId;
          data.telegram_message_id = mediaResult.telegramMessageId;
          data.telegram_file_id = mediaResult.telegramFileId;
          data.media_mimetype = mediaResult.mimetype;
          data.media_filename = mediaResult.filename;
          data.media_size = mediaResult.size;
        }
        break;

      case 'reactionMessage':
        data.reaction_text = messageContent.text || null;
        data.text = messageContent.text ? `Reacted ${messageContent.text}` : 'Removed reaction';
        break;

      default:
        data.text = `[${messageType}]`;
    }

    return data;
  } catch (err) {
    logger.error(`Extract error: ${err.message}`);
    return null;
  }
};

// ============================================
// WEBHOOK FORWARDING - UPDATED
// ============================================
const forwardToWebhooks = async (payload) => {
  if (CONFIG.n8nWebhooks.length === 0) {
    logger.warn('No webhooks configured - skipping forward');
    return;
  }

  for (const webhookUrl of CONFIG.n8nWebhooks) {
    let success = false;
    
    for (let attempt = 0; attempt < CONFIG.webhookRetries; attempt++) {
      try {
        logger.webhook(`Forwarding to ${webhookUrl.substring(0, 50)}... (attempt ${attempt + 1})`);
        
        const response = await axios.post(webhookUrl, payload, {
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'WhatsApp-Bot/2.0-Enhanced'
          },
          timeout: 30000
        });
        
        logger.success(`✓ Webhook success: ${response.status}`);
        success = true;
        break;
      } catch (err) {
        logger.error(`Webhook failed (attempt ${attempt + 1}): ${err.message}`);
        
        if (attempt < CONFIG.webhookRetries - 1) {
          const delayMs = CONFIG.webhookRetryDelays[attempt];
          logger.info(`Retrying in ${delayMs}ms...`);
          await delay(delayMs);
        }
      }
    }
    
    if (!success) {
      logger.error(`Webhook ${webhookUrl} failed after ${CONFIG.webhookRetries} attempts`);
    }
  }
};

// ============================================
// MESSAGE QUEUE
// ============================================
const addToQueue = (task) => {
  STATE.messageQueue.push(task);
  processQueue();
};

const processQueue = async () => {
  if (STATE.processingQueue || STATE.messageQueue.length === 0) return;
  STATE.processingQueue = true;
  
  while (STATE.messageQueue.length > 0) {
    const task = STATE.messageQueue.shift();
    try {
      await task();
      await delay(500);
    } catch (err) {
      logger.error(`Queue task error: ${err.message}`);
    }
  }
  STATE.processingQueue = false;
};

// ============================================
// SEND MESSAGE
// ============================================
const sendMessage = async (jid, message, file = null, filename = null, mimetype = null) => {
  if (!STATE.isConnected || !STATE.sock) {
    throw new Error('Bot not connected');
  }

  try {
    let sentMsg;
    
    if (file) {
      const buffer = Buffer.from(file, 'base64');
      
      if (!mimetype) {
        throw new Error('Mimetype required for file upload');
      }

      const mediaType = mimetype.split('/')[0];
      
      if (mediaType === 'image') {
        sentMsg = await STATE.sock.sendMessage(jid, {
          image: buffer,
          caption: message || '',
          mimetype,
          fileName: filename
        });
      } else if (mediaType === 'video') {
        sentMsg = await STATE.sock.sendMessage(jid, {
          video: buffer,
          caption: message || '',
          mimetype,
          fileName: filename
        });
      } else if (mediaType === 'audio') {
        sentMsg = await STATE.sock.sendMessage(jid, {
          audio: buffer,
          mimetype,
          fileName: filename
        });
      } else {
        sentMsg = await STATE.sock.sendMessage(jid, {
          document: buffer,
          mimetype,
          fileName: filename || 'document'
        });
      }
    } else if (message) {
      sentMsg = await STATE.sock.sendMessage(jid, { text: message });
    } else {
      throw new Error('Either message or file required');
    }
    
    logger.success(`Sent to ${extractPlainPhone(jid) || jid}`);
    
    // NEW: Store outgoing message with all details
    const messageData = {
      message_id: sentMsg.key.id,
      jid,
      from_plain_phone: extractPlainPhone(jid),
      display_name: 'Me (Bot)',
      type: file ? (mimetype.split('/')[0] + 'Message') : 'conversation',
      text: message || (file ? '[Media]' : null),
      media_unique_id: null, // Not storing outbound media to Telegram
      telegram_message_id: null,
      telegram_file_id: null,
      media_mimetype: mimetype || null,
      media_filename: filename || null,
      media_size: file ? Buffer.from(file, 'base64').length : null,
      reaction_text: null,
      is_reply: false,
      reply_to_message_id: null,
      reply_to_text: null,
      chat_type: isPersonalChat(jid) ? 'personal' : 'group',
      from_me: true,
      received_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      raw: sentMsg,
      direction: 'outbound'
    };
    
    await saveMessageToSupabase(messageData);
    // NOTE: Not forwarding to webhooks as per requirement
    
    return sentMsg;
  } catch (err) {
    logger.error(`Send failed: ${err.message}`);
    throw err;
  }
};

const sendMessageQueued = (jid, message, file, filename, mimetype) => {
  return new Promise((resolve, reject) => {
    addToQueue(async () => {
      try {
        const result = await sendMessage(jid, message, file, filename, mimetype);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
};

// ============================================
// INCOMING MESSAGE HANDLER - ENHANCED
// ============================================
const handleIncomingMessage = async (messages) => {
  for (const msg of messages) {
    try {
      if (!msg?.key || !msg?.message) continue;

      const messageType = getContentType(msg.message);
      if (!messageType) continue;

      const ignoredTypes = ['senderKeyDistributionMessage', 'protocolMessage', 'messageContextInfo'];
      if (ignoredTypes.includes(messageType)) continue;

      const jid = msg.key.remoteJid;
      const plainPhone = extractPlainPhone(jid);
      const displayName = msg.pushName || plainPhone || 'Unknown';
      const messageId = msg.key.id;
      const timestamp = new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString();
      const fromMe = msg.key.fromMe || false;

      logger.message(`${chalk.cyan(messageType)} from ${fromMe ? chalk.green('ME') : chalk.yellow(displayName)} ${chalk.gray(`(${plainPhone})`)}`);

      const extractedData = await extractMessageData(msg);
      if (!extractedData) continue;

      const messageData = {
        message_id: messageId,
        jid,
        from_plain_phone: plainPhone,
        display_name: fromMe ? 'Me' : displayName,
        type: messageType,
        ...extractedData,
        chat_type: isPersonalChat(jid) ? 'personal' : 'group',
        from_me: fromMe,
        received_at: timestamp,
        created_at: new Date().toISOString(),
        raw: msg,
        direction: fromMe ? 'outbound' : 'inbound'
      };

      // NEW: Save ALL messages to database (including own messages)
      await saveMessageToSupabase(messageData);

      // NEW: Send read receipt for ALL incoming messages (not just personal chats)
      if (!fromMe) {
        try {
          await STATE.sock.readMessages([msg.key]);
          logger.success(`✓ Blue tick sent for message ${messageId}`);
        } catch (err) {
          logger.warn(`Failed to send read receipt: ${err.message}`);
        }
      }

      // NEW: Forward to webhooks ONLY if NOT from me
      if (!fromMe) {
        const webhookPayload = {
          message_id: messageId,
          jid,
          phone_no: plainPhone,
          display_name: displayName,
          type: messageType,
          text: extractedData.text,
          
          media_unique_id: extractedData.media_unique_id,
          telegram_message_id: extractedData.telegram_message_id,
          telegram_file_id: extractedData.telegram_file_id,
          
          media_mimetype: extractedData.media_mimetype,
          media_filename: extractedData.media_filename,
          media_size: extractedData.media_size,
          
          from_me: false,
          received_at: timestamp,
          is_reply: extractedData.is_reply,
          reply_to_message_id: extractedData.reply_to_message_id,
          reply_to_text: extractedData.reply_to_text,
          reaction_text: extractedData.reaction_text
        };

        await forwardToWebhooks(webhookPayload);
      } else {
        logger.info(`Skipping webhook forward for own message: ${messageId}`);
      }
      
    } catch (err) {
      logger.error(`Message handler: ${err.message}`);
    }
  }
};

// ============================================
// CONNECTION MANAGEMENT
// ============================================
const clearSession = async () => {
  try {
    logger.warn('Clearing session from Supabase...');
    
    const { error } = await supabase.delete('auth_data', { 
      session_id: CONFIG.sessionId
    });
    
    if (error) {
      logger.error(`Error clearing session: ${error.message}`);
    } else {
      logger.success('All auth data deleted from Supabase');
    }
  } catch (err) {
    logger.error(`Clear session error: ${err.message}`);
  }
};

const cleanupConnection = (removeListeners = true) => {
  if (STATE.sock) {
    try {
      if (removeListeners) {
        STATE.sock.ev.removeAllListeners();
      }
      STATE.sock.end(undefined);
    } catch {}
    STATE.sock = null;
  }
  if (STATE.reconnectTimeout) {
    clearTimeout(STATE.reconnectTimeout);
    STATE.reconnectTimeout = null;
  }
  
  // NEW: Stop presence updates
  stopPresenceUpdates();
};

const calculateBackoff = (attempts) => {
  const baseDelay = 5000;
  const delay = Math.min(CONFIG.maxBackoffDelay, baseDelay * attempts);
  return addJitter(delay);
};

// ============================================
// START WHATSAPP CONNECTION - ENHANCED
// ============================================
const startWhatsApp = async () => {
  try {
    cleanupConnection(false);

    logger.line();
    logger.info(`${chalk.cyan('Starting WhatsApp')} ${chalk.gray(`(attempt ${STATE.reconnectAttempts + 1})`)}`);
    
    const { state, saveCreds } = await useSupabaseAuthState();
    
    STATE.authState = state;
    
    if (state.creds?.me) {
      logger.success(`Existing session found: ${chalk.yellow(state.creds.me.id)}`);
    }

    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Baileys v${chalk.cyan(version.join('.'))}`);

    STATE.sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true, // Always mark as online when connecting
      connectTimeoutMs: 120000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: true, // NEW: Enable to receive own messages
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false,
      retryRequestDelayMs: 1000,
      maxMsgRetryCount: 10,
      getMessage: async () => undefined
    });

    STATE.sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          logger.banner('📱 SCAN QR CODE TO LOGIN 📱');
          
          STATE.currentQRString = qr;
          STATE.lastQRTimestamp = new Date().toISOString();
          
          try {
            STATE.currentQR = await QRCode.toDataURL(qr);
            logger.qr(`Open: ${chalk.blue.underline(`http://localhost:${CONFIG.port}/qr`)}`);
          } catch (err) {
            logger.error(`QR generation: ${err.message}`);
          }
          
          logger.line();
          STATE.reconnectAttempts = 0;
        }

        if (connection === 'close') {
          STATE.isConnected = false;
          STATE.currentQR = null;
          STATE.currentQRString = null;
          
          // NEW: Stop presence updates on disconnect
          stopPresenceUpdates();
          
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.output?.payload?.error || 'Unknown';
          
          logger.disconnect(`Code ${chalk.yellow(statusCode)} - ${chalk.yellow(reason)}`);
          
          try {
            await logConnectionEvent('disconnect', statusCode, reason, STATE.reconnectAttempts);
          } catch (err) {
            logger.error(`Logging error: ${err.message}`);
          }

          let shouldReconnect = false;
          let reconnectDelay = 5000;

          if (!statusCode || statusCode === 'undefined') {
            STATE.reconnectAttempts++;
            logger.warn(`Undefined disconnect ${chalk.gray(`(attempt ${STATE.reconnectAttempts})`)} - retrying`);
            shouldReconnect = true;
            reconnectDelay = calculateBackoff(STATE.reconnectAttempts);
          } else {
            switch (statusCode) {
              case DisconnectReason.loggedOut:
                STATE.reconnectAttempts++;
                if (STATE.reconnectAttempts <= 5) {
                  logger.warn(`${chalk.yellow('LOGGED OUT')} - Retrying with existing session (${STATE.reconnectAttempts}/5)`);
                  shouldReconnect = true;
                  reconnectDelay = calculateBackoff(STATE.reconnectAttempts);
                } else {
                  logger.error(`${chalk.red('LOGGED OUT')} - Max retries reached`);
                  logger.error(`Manual clear needed: ${chalk.yellow('POST /clear-session')}`);
                  shouldReconnect = false;
                }
                break;

              case DisconnectReason.connectionClosed:
              case DisconnectReason.connectionLost:
                logger.warn(`${chalk.yellow('Connection lost')} - reconnecting`);
                shouldReconnect = true;
                STATE.reconnectAttempts++;
                reconnectDelay = calculateBackoff(STATE.reconnectAttempts);
                break;

              case DisconnectReason.timedOut:
                logger.warn(`${chalk.yellow('Connection timeout')} - reconnecting`);
                shouldReconnect = true;
                STATE.reconnectAttempts++;
                reconnectDelay = calculateBackoff(STATE.reconnectAttempts);
                break;

              case DisconnectReason.badSession:
                STATE.reconnectAttempts++;
                if (STATE.reconnectAttempts <= 5) {
                  logger.warn(`${chalk.yellow('BAD SESSION')} - Retrying with existing data (${STATE.reconnectAttempts}/5)`);
                  shouldReconnect = true;
                  reconnectDelay = calculateBackoff(STATE.reconnectAttempts);
                } else {
                  logger.error(`${chalk.red('BAD SESSION')} - Max retries reached`);
                  logger.error(`Manual clear needed: ${chalk.yellow('POST /clear-session')}`);
                  shouldReconnect = false;
                }
                break;

              case DisconnectReason.restartRequired:
              case 515:
                logger.success(`✓ ${chalk.green('Pairing completed!')} Creating new socket...`);
                cleanupConnection(true);
                shouldReconnect = true;
                reconnectDelay = 1000;
                STATE.reconnectAttempts = 0;
                break;

              default:
                logger.warn(`Unknown code ${chalk.yellow(statusCode)} - reconnecting`);
                shouldReconnect = true;
                STATE.reconnectAttempts++;
                reconnectDelay = calculateBackoff(STATE.reconnectAttempts);
            }
          }

          if (shouldReconnect) {
            logger.info(`${chalk.cyan('↻ Reconnecting')} in ${chalk.yellow(reconnectDelay / 1000 + 's')} ${chalk.gray(`(attempt ${STATE.reconnectAttempts})`)}`);
            STATE.reconnectTimeout = setTimeout(() => startWhatsApp(), reconnectDelay);
          } else {
            logger.error('❌ Stopped - manual intervention required');
            logger.error(`🔧 Use ${chalk.yellow('POST /clear-session')} then restart`);
          }
        } else if (connection === 'open') {
          STATE.isConnected = true;
          STATE.currentQR = null;
          STATE.currentQRString = null;
          STATE.reconnectAttempts = 0;
          STATE.lastSuccessfulConnection = new Date().toISOString();
          STATE.connectedUser = STATE.sock.user;
          
          logger.banner('🎉 WHATSAPP CONNECTED! 🎉');
          logger.connect(`Account: ${chalk.yellow(STATE.sock.user?.id || 'Unknown')}`);
          logger.connect(`Name: ${chalk.yellow(STATE.sock.user?.name || 'Unknown')}`);
          logger.line();
          
          // NEW: Start presence updates to stay online
          startPresenceUpdates();
          
          try {
            await logConnectionEvent('connected', 200, 'Success', 0);
          } catch (err) {
            logger.error(`Logging error: ${err.message}`);
          }
        } else if (connection === 'connecting') {
          logger.info(`${chalk.cyan('Connecting to WhatsApp...')}`);
        }
      } catch (err) {
        logger.error(`Connection update error: ${err.message}`);
      }
    });

    STATE.sock.ev.on('creds.update', async () => {
      try {
        logger.db('Credentials updated - saving...');
        await saveCreds();
      } catch (err) {
        logger.error(`Error saving credentials: ${err.message}`);
      }
    });
    
    STATE.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify' || type === 'append') { // NEW: Also handle 'append' for own messages
        handleIncomingMessage(messages).catch(err => {
          logger.error(`Message processing error: ${err.message}`);
        });
      }
    });

    STATE.sock.ev.on('error', (err) => {
      logger.error(`Socket error: ${err.message}`);
    });

  } catch (err) {
    logger.error(`Startup error: ${err.message}`);
    
    const isAuthError = err.message.includes('decrypt') || 
                       err.message.includes('invalid') || 
                       err.message.includes('corrupt') ||
                       err.message.includes('malformed');
    
    STATE.reconnectAttempts++;
    
    if (isAuthError) {
      if (STATE.reconnectAttempts <= 10) {
        logger.warn(`${chalk.yellow('Auth error detected')} - Retrying with existing session (${STATE.reconnectAttempts}/10)`);
        const retryDelay = calculateBackoff(STATE.reconnectAttempts);
        STATE.reconnectTimeout = setTimeout(() => startWhatsApp(), retryDelay);
      } else {
        logger.error(`${chalk.red('Auth error persists')} - Manual clear needed`);
        logger.error(`Use: ${chalk.yellow('POST /clear-session')}`);
      }
    } else {
      const retryDelay = calculateBackoff(STATE.reconnectAttempts);
      logger.warn(`Retrying in ${chalk.yellow(retryDelay / 1000 + 's')} ${chalk.gray(`(attempt ${STATE.reconnectAttempts})`)}`);
      STATE.reconnectTimeout = setTimeout(() => startWhatsApp(), retryDelay);
    }
  }
};

// ============================================
// EXPRESS APP
// ============================================
const app = express();

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const authMiddleware = (req, res, next) => {
  const authKey = req.headers['auth-key'];
  if (!authKey || authKey !== CONFIG.authKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: STATE.isConnected,
    last_qr: STATE.lastQRTimestamp,
    uptime: process.uptime(),
    reconnect_attempts: STATE.reconnectAttempts,
    last_connection: STATE.lastSuccessfulConnection,
    telegram_configured: !!CONFIG.telegramBotToken && !!CONFIG.telegramChatId,
    self_ping_enabled: CONFIG.selfPingEnabled,
    presence_updates_active: !!STATE.presenceInterval,
    user: STATE.connectedUser ? {
      id: STATE.connectedUser.id,
      name: STATE.connectedUser.name
    } : null
  });
});

app.get('/qr', (req, res) => {
  if (STATE.isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Connected</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            margin: 0;
          }
          .container {
            background: white;
            padding: 60px;
            border-radius: 20px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          }
          h1 {
            color: #25D366;
            margin: 0 0 20px 0;
            font-size: 32px;
          }
          .status {
            color: #666;
            font-size: 18px;
          }
          .user {
            margin-top: 20px;
            padding: 20px;
            background: #f5f5f5;
            border-radius: 10px;
          }
          .feature {
            margin-top: 10px;
            padding: 15px;
            background: #e8f5e9;
            border-radius: 10px;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Connected</h1>
          <p class="status">WhatsApp is connected and ready</p>
          ${STATE.connectedUser ? `
            <div class="user">
              <strong>Account:</strong> ${STATE.connectedUser.name || STATE.connectedUser.id}
            </div>
          ` : ''}
          <div class="feature">
            <strong>✅ Always Online</strong><br>
            <strong>✅ Blue Ticks on All Messages</strong><br>
            <strong>✅ All Messages Stored</strong><br>
            <strong>✅ Telegram Media Storage</strong><br>
            <strong>✅ Self-Ping Active</strong>
          </div>
        </div>
      </body>
      </html>
    `);
  }

  if (!STATE.currentQR) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Waiting for QR</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="refresh" content="5">
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
          }
          .container {
            background: white;
            padding: 60px;
            border-radius: 20px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          }
          h1 { margin: 0; color: #333; }
          p { color: #666; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⏳ Waiting for QR Code...</h1>
          <p>Refreshing in 5 seconds...</p>
        </div>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Scan QR Code</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          margin: 0;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 20px;
          text-align: center;
          box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          max-width: 500px;
        }
        h1 {
          margin: 0 0 10px 0;
          color: #333;
          font-size: 28px;
        }
        .instructions {
          color: #666;
          font-size: 14px;
          margin: 10px 0 30px 0;
          line-height: 1.6;
        }
        #qr-image {
          max-width: 350px;
          margin: 20px auto;
          border-radius: 10px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        .status {
          margin-top: 20px;
          padding: 15px;
          background: #f5f5f5;
          border-radius: 8px;
          font-size: 13px;
          color: #666;
        }
      </style>
      <script>
        let pollInterval = ${CONFIG.qrPollInterval};
        
        function refreshQR() {
          fetch('/qr.png?t=' + Date.now())
            .then(response => {
              if (response.ok) {
                return response.blob();
              } else {
                window.location.reload();
              }
            })
            .then(blob => {
              if (blob) {
                const url = URL.createObjectURL(blob);
                document.getElementById('qr-image').src = url;
              }
            })
            .catch(() => {
              window.location.reload();
            });
        }
        
        setInterval(refreshQR, pollInterval);
        
        setInterval(() => {
          fetch('/health')
            .then(r => r.json())
            .then(data => {
              if (data.connected) {
                window.location.reload();
              }
            });
        }, 5000);
      </script>
    </head>
    <body>
      <div class="container">
        <h1>📱 Scan QR Code</h1>
        <div class="instructions">
          1. Open WhatsApp on your phone<br>
          2. Tap <strong>Menu</strong> or <strong>Settings</strong><br>
          3. Tap <strong>Linked Devices</strong><br>
          4. Tap <strong>Link a Device</strong><br>
          5. Point your phone at this screen to capture the QR code
        </div>
        <img id="qr-image" src="/qr.png" alt="QR Code">
        <div class="status">
          QR code refreshes automatically every ${CONFIG.qrPollInterval / 1000} seconds
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/qr.png', (req, res) => {
  if (!STATE.currentQR) {
    return res.status(404).json({ error: 'QR not available' });
  }
  
  const base64Data = STATE.currentQR.replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
  res.end(buffer);
});

app.get('/media/:uniqueId', authMiddleware, async (req, res) => {
  try {
    const { uniqueId } = req.params;
    
    const { data, error } = await supabase.query('messages', 'GET', {
      select: 'telegram_file_id,media_filename,media_mimetype',
      eq: { media_unique_id: uniqueId },
      single: true
    });
    
    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Media not found' });
    }
    
    if (!data.telegram_file_id) {
      return res.status(404).json({ success: false, error: 'No Telegram file reference' });
    }
    
    const buffer = await getMediaFromTelegram(data.telegram_file_id);
    
    res.writeHead(200, {
      'Content-Type': data.media_mimetype || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${data.media_filename || 'file'}"`,
      'Content-Length': buffer.length
    });
    res.end(buffer);
    
  } catch (err) {
    logger.error(`Media retrieval error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send', authMiddleware, async (req, res) => {
  try {
    const { jid, message, file, filename, mimetype } = req.body;

    if (!jid) {
      return res.status(400).json({ success: false, error: 'Missing required field: jid' });
    }

    if (!message && !file) {
      return res.status(400).json({ success: false, error: 'Either message or file required' });
    }

    if (!STATE.isConnected) {
      return res.status(503).json({ success: false, error: 'Bot not connected' });
    }

    if (file) {
      const fileSize = Buffer.from(file, 'base64').length;
      if (fileSize > 100 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: 'File too large (max 100MB)' });
      }
    }

    const sentMsg = await sendMessageQueued(jid, message || null, file || null, filename || null, mimetype || null);
    
    res.json({
      success: true,
      message_id: sentMsg.key.id,
      timestamp: new Date().toISOString(),
      raw: sentMsg
    });
  } catch (err) {
    logger.error(`Send API error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhook-test', authMiddleware, async (req, res) => {
  try {
    const payload = req.body;
    await forwardToWebhooks(payload);
    res.json({ success: true, message: 'Webhook test sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/clear-session', authMiddleware, async (req, res) => {
  try {
    logger.warn('🗑️ Clearing session via API...');
    
    cleanupConnection();
    STATE.isConnected = false;
    
    // NEW: Stop self-ping during session clear
    stopSelfPing();
    
    await clearSession();
    
    res.json({ success: true, message: 'Session cleared, restarting...' });
    
    setTimeout(() => {
      logger.info('Restarting WhatsApp after session clear...');
      startWhatsApp();
      
      // Restart self-ping
      setTimeout(() => startSelfPing(), 5000);
    }, 3000);
  } catch (err) {
    logger.error(`Clear session error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// START SERVER
// ============================================
const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log('\n');
  logger.banner('🚀 WHATSAPP API SERVER - ENHANCED VERSION 🚀');
  logger.success(`Port: ${chalk.yellow(CONFIG.port)}`);
  logger.info(`QR Page: ${chalk.blue(`http://localhost:${CONFIG.port}/qr`)}`);
  logger.info(`Health: ${chalk.blue(`http://localhost:${CONFIG.port}/health`)}`);
  
  if (CONFIG.telegramBotToken && CONFIG.telegramChatId) {
    logger.success(`📤 Telegram: ${chalk.green('Configured')} (Chat ID: ${CONFIG.telegramChatId})`);
  } else {
    logger.error('❌ Telegram: Not configured');
  }
  
  if (CONFIG.n8nWebhooks.length > 0) {
    logger.success(`Webhooks: ${chalk.yellow(CONFIG.n8nWebhooks.length)} configured`);
  } else {
    logger.warn('⚠️  No webhooks - messages will NOT be forwarded');
  }
  
  logger.line();
  logger.success('✅ Media Storage: TELEGRAM');
  logger.success('✅ Always Online: ENABLED');
  logger.success('✅ Blue Ticks: ALL MESSAGES');
  logger.success('✅ Store Own Messages: YES');
  logger.success('✅ Forward Own Messages: NO');
  logger.success(`✅ Self-Ping: ${CONFIG.selfPingEnabled ? 'ENABLED' : 'DISABLED'}`);
  logger.line();
  
  setTimeout(() => {
    startWhatsApp();
    // Start self-ping after connection established
    setTimeout(() => startSelfPing(), 10000);
  }, 2000);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
const shutdown = async (signal) => {
  logger.warn(`${signal} received - shutting down gracefully...`);
  
  // NEW: Stop self-ping
  stopSelfPing();
  
  if (STATE.reconnectTimeout) {
    clearTimeout(STATE.reconnectTimeout);
  }
  
  if (STATE.sock && STATE.isConnected) {
    try {
      logger.info('Disconnecting gracefully...');
      
      // NEW: Stop presence updates
      stopPresenceUpdates();
      
      STATE.sock.end(undefined);
      logger.success('Disconnected');
    } catch (err) {
      logger.error(`Shutdown error: ${err.message}`);
    }
  }
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  setTimeout(() => {
    logger.warn('Forcing exit...');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled rejection: ${reason}`);
});
