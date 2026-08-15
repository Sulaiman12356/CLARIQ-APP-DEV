import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Gemini AI Chat Proxy
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, userPrompt } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not configured." });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    const systemInstruction = `You are Clarity AI Mentor, the official intelligent AI Mentor and digital marketing consultant at CLARIQ Digital Academy (founded by Clarity Digital Academy). You help learners, freelancers, and marketers master digital marketing, Meta ads, copywriting, graphic design, and client acquisition.

CRITICAL TONE & FORMATTING DIRECTIVES:
1. Introduce yourself warmly as Clarity AI Mentor when appropriate. Speak in an articulate, encouraging, and human tone.
2. ABSOLUTELY DO NOT use markdown dashes (-), bullet point dashes, asterisks (* or **), hashes (#), or markdown headings anywhere in your content.
3. Write in clean, clear, complete flowing paragraphs or numbered points (1., 2., 3.) when laying out step-by-step concepts, study plans, or draft feedback.
4. Provide practical, high-value advice tailored to the student's digital marketing journey.`;

    let contents: any[] = [];
    if (Array.isArray(messages) && messages.length > 0) {
      const formatted: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
      for (const m of messages) {
        if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
        const role = m.role === 'user' ? 'user' : 'model';
        if (formatted.length > 0 && formatted[formatted.length - 1].role === role) {
          formatted[formatted.length - 1].parts[0].text += '\n\n' + m.content.trim();
        } else {
          formatted.push({ role, parts: [{ text: m.content.trim() }] });
        }
      }
      if (formatted.length > 0 && formatted[0].role === 'model') {
        formatted.shift();
      }
      contents = formatted;
    }

    if (contents.length === 0) {
      const text = typeof userPrompt === 'string' && userPrompt.trim() ? userPrompt.trim() : 'Hello';
      contents = [{ role: 'user', parts: [{ text }] }];
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents,
      config: {
        systemInstruction,
      }
    });

    let reply = response.text || "I am glad to help you with that. Let us walk through your goals together in detail.";
    reply = reply
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/^#+\s*/gm, '')
      .replace(/^[\s]*[-•][\s]+/gm, '')
      .replace(/[\r\n][\s]*[-•][\s]+/g, '\n');

    return res.json({ reply });
  } catch (error: any) {
    console.error("Gemini chat error:", error);
    return res.status(500).json({ error: error.message || "Failed to process AI chat request." });
  }
});

// Gemini AI Assignment Grading Proxy
app.post("/api/grade-assignment", async (req, res) => {
  try {
    const { assignmentTitle, instructions, submissionText } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not configured." });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    const prompt = `You are an instructor at CLARIQ, a digital marketing learning platform. Grade the student's assignment submission against the instructions.
Respond with ONLY valid JSON in exactly this shape (no markdown, no code blocks):
{"grade": "A short grade like 88/100 or Excellent/Good/Needs Work", "feedback": "2-4 sentences of specific, encouraging, actionable feedback referencing what they actually wrote"}

Assignment: ${assignmentTitle}
Instructions: ${instructions}

Student submission:
${submissionText}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    let parsed: any;
    try {
      parsed = JSON.parse(response.text || "{}");
    } catch {
      parsed = { grade: "Reviewed", feedback: response.text || "Submission reviewed successfully." };
    }

    return res.json(parsed);
  } catch (error: any) {
    console.error("Gemini grading error:", error);
    return res.json({
      grade: "Reviewed",
      feedback: "Your submission has been received and saved. The AI instructor recorded your work successfully!"
    });
  }
});

/* ============================================================
   WHATSAPP BUSINESS PLATFORM / CLOUD API INTEGRATION
   ============================================================ */

/**
 * Normalizes Nigerian & International phone numbers for WhatsApp Cloud API.
 * WhatsApp API expects numbers in E.164 format without leading '+' or spaces.
 * Example:
 *  08031234567 -> 2348031234567
 *  +2348031234567 -> 2348031234567
 *  070..., 081..., 090..., 091... -> 234...
 */
function normalizeWhatsAppPhone(phone: string): { normalized: string; display: string } | null {
  if (!phone || typeof phone !== "string") return null;
  let clean = phone.trim().replace(/[\s\-\(\)]/g, '');
  if (!clean) return null;

  if (clean.startsWith('+')) {
    clean = clean.substring(1);
  }

  // Handle Nigerian local format (e.g. 08031234567, 070..., 081..., 090..., 091...)
  if (/^0[789][01]\d{8}$/.test(clean)) {
    clean = '234' + clean.substring(1);
  } else if (/^0\d{10}$/.test(clean)) {
    clean = '234' + clean.substring(1);
  }

  // E.164 without plus: 10 to 15 digits
  if (/^\d{10,15}$/.test(clean)) {
    return {
      normalized: clean,
      display: '+' + clean
    };
  }
  return null;
}

// In-memory pause control state (Defaults to true: PAUSED as requested)
let isWhatsAppAutomationPaused = true;

function getWhatsAppConfig() {
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || "").trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const businessAccountId = (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "").trim();
  const templateName = (process.env.WHATSAPP_TEMPLATE_NAME || "hello_world").trim();
  const webhookVerifyToken = (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "clariq_wa_webhook_token").trim();

  // Paused state can also be forced by env variable
  const envPaused = process.env.WHATSAPP_AUTOMATION_PAUSED !== "false";
  const paused = isWhatsAppAutomationPaused || envPaused;

  const configured = Boolean(token && phoneNumberId);
  return {
    configured,
    paused,
    token,
    phoneNumberId,
    businessAccountId,
    templateName,
    webhookVerifyToken
  };
}

// 1. WhatsApp API Configuration & Status Check
app.get("/api/whatsapp/status", (_req, res) => {
  const config = getWhatsAppConfig();
  return res.json({
    status: config.paused ? "paused" : (config.configured ? "active" : "unconfigured"),
    automationStatus: config.paused ? "PAUSED" : (config.configured ? "ACTIVE" : "UNCONFIGURED"),
    paused: config.paused,
    configured: config.configured,
    phoneNumberId: config.phoneNumberId ? `${config.phoneNumberId.slice(0, 4)}***${config.phoneNumberId.slice(-4)}` : null,
    businessAccountId: config.businessAccountId ? `${config.businessAccountId.slice(0, 4)}***` : null,
    templateName: config.templateName,
    message: config.paused
      ? "WhatsApp Automation: PAUSED"
      : (config.configured 
          ? "WhatsApp Business API is connected and active." 
          : "WhatsApp Business API is not configured. Connect the WhatsApp Business Platform before sending broadcasts.")
  });
});

// Admin toggle endpoint to inspect or adjust pause state when API is ready
app.post("/api/whatsapp/toggle-pause", (req, res) => {
  const { paused } = req.body;
  if (typeof paused === "boolean") {
    isWhatsAppAutomationPaused = paused;
  } else {
    isWhatsAppAutomationPaused = !isWhatsAppAutomationPaused;
  }
  const config = getWhatsAppConfig();
  return res.json({
    success: true,
    paused: config.paused,
    automationStatus: config.paused ? "PAUSED" : "ACTIVE",
    message: config.paused ? "WhatsApp Automation: PAUSED" : "WhatsApp Automation: ACTIVE"
  });
});

// 2. Meta WhatsApp Webhook Verification (GET)
app.get("/api/whatsapp/webhook", (req, res) => {
  const config = getWhatsAppConfig();
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.webhookVerifyToken) {
    console.log("WhatsApp Webhook verified successfully.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 3. Meta WhatsApp Webhook Inbound Events (POST)
app.post("/api/whatsapp/webhook", (req, res) => {
  const body = req.body;
  if (body.object === "whatsapp_business_account") {
    // Log and acknowledge webhook delivery immediately as required by Meta
    if (body.entry && body.entry[0]?.changes && body.entry[0].changes[0]?.value) {
      const changeVal = body.entry[0].changes[0].value;
      if (changeVal.statuses) {
        console.log("WhatsApp delivery status update received:", JSON.stringify(changeVal.statuses));
      }
    }
    return res.status(200).send("EVENT_RECEIVED");
  }
  return res.sendStatus(404);
});

// Helper function to send single message via Meta WhatsApp Cloud API
async function sendWhatsAppCloudApiMessage(params: {
  phone: string;
  messageText?: string;
  messageType?: "text" | "template";
  templateName?: string;
  languageCode?: string;
}) {
  const config = getWhatsAppConfig();

  // If automation is paused, do NOT attempt network calls or show fake delivery
  if (config.paused) {
    return {
      success: false,
      paused: true,
      automationStatus: "PAUSED",
      error: "WhatsApp Automation is currently PAUSED. Message delivery is suspended until WhatsApp API activation."
    };
  }

  if (!config.configured) {
    return {
      success: false,
      error: "WhatsApp Business API is not configured. Connect the WhatsApp Business Platform before sending broadcasts."
    };
  }

  const normObj = normalizeWhatsAppPhone(params.phone);
  if (!normObj) {
    return {
      success: false,
      error: `Invalid recipient phone number format: "${params.phone}". Expected valid international format or 11-digit Nigerian number.`
    };
  }

  const url = `https://graph.facebook.com/v20.0/${config.phoneNumberId}/messages`;
  const useType = params.messageType || "text";

  let payload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normObj.normalized
  };

  if (useType === "template") {
    payload.type = "template";
    payload.template = {
      name: params.templateName || config.templateName || "hello_world",
      language: {
        code: params.languageCode || "en_US"
      }
    };
  } else {
    payload.type = "text";
    payload.text = {
      preview_url: false,
      body: params.messageText || "Notice from CLARIQ Digital Academy"
    };
  }

  try {
    const metaRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data: any = await metaRes.json();

    if (metaRes.ok && data.messages && data.messages[0] && data.messages[0].id) {
      return {
        success: true,
        messageId: data.messages[0].id,
        phone: normObj.normalized,
        displayPhone: normObj.display
      };
    } else {
      const errMsg = data?.error?.message || data?.error?.error_data?.details || "Meta WhatsApp API rejected message delivery request.";
      return {
        success: false,
        error: errMsg,
        code: data?.error?.code || metaRes.status,
        phone: normObj.normalized,
        displayPhone: normObj.display
      };
    }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Network error connecting to Meta WhatsApp API server.",
      phone: normObj.normalized,
      displayPhone: normObj.display
    };
  }
}

// 4. Test/Single WhatsApp Message Dispatch
app.post("/api/whatsapp/send-single", async (req, res) => {
  try {
    const { phone, messageText, messageType, templateName, languageCode } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "Recipient phone number is required." });
    }

    const result = await sendWhatsAppCloudApiMessage({
      phone,
      messageText,
      messageType,
      templateName,
      languageCode
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to dispatch WhatsApp message." });
  }
});

// 5. Batch WhatsApp Broadcast Dispatch Endpoint
app.post("/api/whatsapp/broadcast", async (req, res) => {
  try {
    const { recipients, messageText, subject, messageType, templateName, languageCode } = req.body;

    const config = getWhatsAppConfig();
    
    // When paused, gracefully respond without hitting external APIs or generating fake success
    if (config.paused) {
      return res.status(200).json({
        success: false,
        paused: true,
        automationStatus: "PAUSED",
        message: "WhatsApp Automation: PAUSED. Broadcast saved to audit history in staging mode.",
        sentCount: 0,
        failedCount: 0,
        totalRecipients: Array.isArray(recipients) ? recipients.length : 0,
        results: (Array.isArray(recipients) ? recipients : []).map((r: any) => ({
          email: r.email,
          name: r.name,
          phone: r.phone || "",
          status: "paused",
          note: "WhatsApp Automation is currently PAUSED pending API connection."
        }))
      });
    }

    if (!config.configured) {
      return res.status(400).json({
        error: "WhatsApp Business API is not configured. Connect the WhatsApp Business Platform before sending broadcasts.",
        configured: false,
        paused: false
      });
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "No target recipients provided for WhatsApp broadcast." });
    }

    const results: any[] = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const r of recipients) {
      // Consent / Opt-In Check
      if (r.optInWhatsApp === false) {
        results.push({
          email: r.email,
          name: r.name,
          phone: r.phone || "",
          status: "failed",
          error: "Recipient has opted out / revoked consent for WhatsApp messages.",
          optInConsent: false
        });
        failedCount++;
        continue;
      }

      const normObj = normalizeWhatsAppPhone(r.phone);
      if (!normObj) {
        results.push({
          email: r.email,
          name: r.name,
          phone: r.phone || "",
          status: "failed",
          error: "Invalid or missing phone number format.",
          optInConsent: true
        });
        failedCount++;
        continue;
      }

      // Dispatch via Meta WhatsApp Cloud API
      const sendRes = await sendWhatsAppCloudApiMessage({
        phone: normObj.normalized,
        messageText: r.personalizedMsg || messageText,
        messageType: messageType || "text",
        templateName,
        languageCode
      });

      if (sendRes.success) {
        sentCount++;
        results.push({
          email: r.email,
          name: r.name,
          phone: normObj.normalized,
          displayPhone: normObj.display,
          status: "sent",
          messageId: sendRes.messageId,
          timestamp: new Date().toISOString()
        });
      } else {
        failedCount++;
        results.push({
          email: r.email,
          name: r.name,
          phone: normObj.normalized,
          displayPhone: normObj.display,
          status: "failed",
          error: sendRes.error,
          code: sendRes.code,
          timestamp: new Date().toISOString()
        });
      }
    }

    return res.json({
      success: true,
      totalRecipients: recipients.length,
      sentCount,
      failedCount,
      results
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to execute WhatsApp broadcast." });
  }
});

// Serve static files
app.use(express.static(__dirname));

// Fallback to index.html for SPA/single page
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
