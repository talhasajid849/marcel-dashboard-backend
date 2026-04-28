'use strict';

/**
 * AI Service - Exact implementation from bot's ai.js
 * Adapted for dashboard backend (uses process.env instead of bot config)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Tool definition (from bot's tools.js)
const SAVE_BOOKING_FIELD_TOOL = {
  type: 'function',
  function: {
    name: 'save_booking_field',
    description: 'Save a single field of the booking form.',
    parameters: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'The booking field name to save.',
        },
        value: {
          type: 'string',
          description: 'The value to save for the field.',
        },
      },
      required: ['field', 'value'],
    },
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── cleanReplyText ──────────────────────────────────────────────────────────
// Strips internal monologue and leaked tool calls from AI replies.
// Copied exactly from bot ai.js
function cleanReplyText(rawText) {
  if (!rawText) return { cleanedText: '', leakedToolCalls: [] };

  let text = rawText;
  const leakedToolCalls = [];

  // 1. Strip <think>...</think> blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/<think>[\s\S]*$/i, '').trim();

  // 2. Extract markdown-style tool call leaks
  const toolCallRegex = /\**`?save_booking_field\s*\(\s*([^)]+?)\s*\)`?\**/gi;
  let match;
  while ((match = toolCallRegex.exec(rawText)) !== null) {
    const argsRaw = match[1];
    const quoted = argsRaw.match(/['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
    if (quoted) {
      leakedToolCalls.push({
        id:        null,
        name:      'save_booking_field',
        arguments: JSON.stringify({ field: quoted[1], value: quoted[2] }),
      });
    }
  }
  text = text.replace(/\**`?save_booking_field\s*\([^)]+\)`?\**/gi, '').trim();

  // 3. Strip internal monologue paragraphs
  const monologueStarters = [
    /^the user\b/i,
    /^the customer\b/i,
    /^i need to\b/i,
    /^i should\b/i,
    /^i'?ll\b/i,
    /^i'?ve\b/i,
    /^i'?m going to\b/i,
    /^let me\b/i,
    /^looking at\b/i,
    /^looking back\b/i,
    /^checking\b/i,
    /^after saving\b/i,
    /^still missing\b/i,
    /^so next\b/i,
    /^so i\b/i,
    /^so they said\b/i,
    /^wait\b/i,
    /^hmm\b/i,
    /^hmmm\b/i,
    /^actually\b/i,
    /^actually,? /i,
    /^according to\b/i,
    /^based on\b/i,
    /^now i\b/i,
    /^now,? /i,
    /^okay,? (let|so|i)\b/i,
    /^ok,? (let|so|i)\b/i,
    /^first,? (i|let)\b/i,
    /^next,? (i|let)\b/i,
    /^then (i|they|the customer)\b/i,
    /^but they\b/i,
    /^but i\b/i,
    /^they (said|agreed|confirmed|mentioned|asked|wrote|typed)\b/i,
    /^from (what|the)\b/i,
    /^given (that|the)\b/i,
    /^since (the|they)\b/i,
    /^also,? i\b/i,
    /^also,? (let|so)\b/i,
    /^thinking\b/i,
    /^considering\b/i,
    /^reviewing\b/i,
    /^i notice\b/i,
    /^i see that\b/i,
    /^i see they\b/i,
    /^i remember\b/i,
  ];

  const paragraphs     = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const cleanParagraphs = paragraphs.filter(p => {
    for (const re of monologueStarters) {
      if (re.test(p)) return false;
    }
    return true;
  });
  text = cleanParagraphs.join('\n\n').trim();

  // 4. Fallback to last paragraph if everything was stripped
  if (!text && paragraphs.length > 0) {
    text = paragraphs[paragraphs.length - 1];
  }

  // 5. Final cleanup
  text = text.replace(/^marcel\s*[:\-]\s*/i, '').trim();
  text = text.replace(/\n{3,}/g, '\n\n');

  return { cleanedText: text, leakedToolCalls };
}

// ── sanitizeUrls ────────────────────────────────────────────────────────────
// Removes any URL not in the whitelist. Prevents hallucinated payment links.
// Copied exactly from bot ai.js
function sanitizeUrls(text, allowedUrls) {
  if (!text) return { sanitized: '', removed: [] };

  const allowSet = new Set(
    (allowedUrls || []).map(u => String(u).toLowerCase().replace(/\/+$/, ''))
  );

  const urlRegex = /https?:\/\/[^\s<>"'`\]]+/gi;
  const removed  = [];

  const sanitized = text.replace(urlRegex, (match) => {
    const clean           = match.replace(/[.,;:!?)\]]+$/, '');
    const cleanNormalized = clean.toLowerCase().replace(/\/+$/, '');
    if (allowSet.has(cleanNormalized)) return clean;
    removed.push(clean);
    return '[link removed]';
  });

  return { sanitized, removed };
}

// ── callModel ───────────────────────────────────────────────────────────────
// Raw HTTP call to OpenRouter. Copied exactly from bot ai.js
function callModel(model, messages, apiKey, baseUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const modelId = model.startsWith('openrouter/')
      ? model.replace('openrouter/', '')
      : model;

    const payload = {
      model:       modelId === 'auto' ? 'openrouter/auto' : modelId,
      messages,
      tools:       [SAVE_BOOKING_FIELD_TOOL],
      tool_choice: 'auto',
      max_tokens:  600,
      temperature: 0.7,
    };

    const body = JSON.stringify(payload);

    let url;
    try {
      url = new URL(baseUrl + '/chat/completions');
    } catch (e) {
      return reject(new Error('Invalid baseUrl: ' + baseUrl));
    }

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  'Bearer ' + apiKey,
        'HTTP-Referer':   'https://honkhireco.com.au',
        'X-Title':        'Marcel Bot - Honk Hire Co',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          return reject(new Error('Parse error: ' + data.substring(0, 200)));
        }

        if (parsed.error) {
          return reject(new Error('API error: ' + (parsed.error.message || JSON.stringify(parsed.error))));
        }

        const choice = parsed.choices?.[0];
        if (!choice) return reject(new Error('No choices in response'));

        const message = choice.message;
        if (!message) return reject(new Error('No message in choice'));

        const rawText = (message.content || '').trim();
        const { cleanedText, leakedToolCalls } = cleanReplyText(rawText);

        const toolCalls = [];
        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            if (tc.type === 'function' && tc.function) {
              let parsedArgs;
              try { parsedArgs = JSON.parse(tc.function.arguments); }
              catch (e) { parsedArgs = {}; }
              toolCalls.push({ id: tc.id || null, name: tc.function.name, input: parsedArgs });
            }
          }
        } else if (message.function_call) {
          toolCalls.push({ id: null, name: message.function_call.name, arguments: message.function_call.arguments });
        }

        for (const leak of leakedToolCalls) {
          toolCalls.push(leak);
        }

        resolve({ text: cleanedText, toolCalls, raw: message });
      });
    });

    req.on('error', err => reject(new Error('Request error: ' + err.message)));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Timeout after ' + timeoutMs + 'ms'));
    });

    req.write(body);
    req.end();
  });
}

// ── getReply ─────────────────────────────────────────────────────────────────
// Main function. Handles tool protocol round-trips + model fallback chain.
// Copied exactly from bot ai.js, adapted to use process.env
async function getReply(conversationMessages, customerContext) {
  const apiKey  = process.env.OPENROUTER_API_KEY;
  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const primary = process.env.AI_MODEL || 'moonshotai/kimi-k2';
  const fallbacks = (process.env.AI_FALLBACK_MODELS || 'deepseek/deepseek-chat').split(',').map(m => m.trim()).filter(Boolean);

  if (!apiKey) {
    console.error('❌ AI: no OPENROUTER_API_KEY configured');
    return null;
  }

  const modelChain = [primary, ...fallbacks].filter(Boolean);

  // Load marcel.md fresh each turn
  let marcelPrompt;
  try {
    marcelPrompt = fs.readFileSync(path.join(__dirname, '../prompts/marcel.md'), 'utf8');
  } catch (e) {
    console.error('❌ AI: Failed to load marcel.md:', e.message);
    return null;
  }

  const systemContent = marcelPrompt + (customerContext ? '\n\n---\n' + customerContext : '');

  const messages = [
    { role: 'system', content: systemContent },
    ...conversationMessages,
  ];

  const timeoutMs         = parseInt(process.env.AI_TIMEOUT_MS  || '30000');
  const maxNetworkRetries = parseInt(process.env.AI_RETRIES      || '2');
  const retryDelayMs      = parseInt(process.env.AI_RETRY_DELAY  || '1000');
  const MAX_PROTOCOL_ROUNDS = 3;

  for (const model of modelChain) {
    try {
      const accumulatedToolCalls = [];
      let finalText      = '';
      let modelSucceeded = false;

      for (let round = 0; round < MAX_PROTOCOL_ROUNDS; round++) {
        let result  = null;
        let lastErr = null;

        for (let attempt = 0; attempt <= maxNetworkRetries; attempt++) {
          try {
            console.log(`🤖 AI call model=${model} attempt=${attempt + 1} round=${round + 1}`);
            result = await callModel(model, messages, apiKey, baseUrl, timeoutMs);
            break;
          } catch (err) {
            lastErr = err;
            console.warn(`⚠️  AI call failed model=${model} attempt=${attempt + 1}: ${err.message}`);
            if (attempt < maxNetworkRetries) await sleep(retryDelayMs);
          }
        }

        if (!result) {
          console.warn(`⚠️  All retries failed for model=${model}`);
          break;
        }

        console.log(`✅ AI replied model=${model} round=${round + 1} textLen=${result.text.length} tools=${result.toolCalls.length}`);

        if (result.toolCalls && result.toolCalls.length > 0) {
          for (const tc of result.toolCalls) accumulatedToolCalls.push(tc);
        }

        if (result.text && result.text.trim().length > 0) {
          finalText      = result.text;
          modelSucceeded = true;
          break;
        }

        if (result.toolCalls && result.toolCalls.length > 0) {
          return { text: '', toolCalls: accumulatedToolCalls, model };
        }

        if (round === 0) { continue; }
        console.warn(`⚠️  Model returned empty text twice: ${model}`);
        break;
      }

      if (modelSucceeded) {
        return { text: finalText, toolCalls: accumulatedToolCalls, model };
      }

      if (accumulatedToolCalls.length > 0) {
        console.warn(`⚠️  Model failed text but captured tool calls: ${model}`);
        return { text: '', toolCalls: accumulatedToolCalls, model };
      }

    } catch (err) {
      console.error(`❌ AI unexpected error model=${model}:`, err.message);
    }
  }

  console.error('❌ All AI models failed');
  return null;
}

module.exports = { getReply, cleanReplyText, sanitizeUrls };
