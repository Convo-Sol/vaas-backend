
import express from "express";
import { createClient } from "@supabase/supabase-js";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

// Setup Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Extract using Groq API
async function extractFromTranscript(raw_transcript) {
  const transcript = raw_transcript.slice(-3000); // last 3000 chars

  try {
    console.log("Sending to Groq:", transcript);
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-8b-8192",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are an AI that extracts order details from a phone call transcript. Return a JSON with these fields: caller_name, phone_number, order, quantity. Use 'Unknown' if something is missing.",
          },
          {
            role: "user",
            content: `Transcript:\n\n${transcript}`,
          },
        ],
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const parsed = response.data.choices[0].message.content;
    const parsedJSON = JSON.parse(parsed);

    const quantityInt = parseInt(parsedJSON.quantity, 10);

    return {
      caller_name: parsedJSON.caller_name || "Unknown",
      phone_number: parsedJSON.phone_number || "Unknown",
      order: parsedJSON.order || "Unknown",
      quantity: !isNaN(quantityInt) ? quantityInt : 1,
    };
  } catch (err) {
    console.error("❌ Groq API error:", err.message);
    return {
      caller_name: "Unknown",
      phone_number: "Unknown",
      order: "Unknown",
      quantity: 1,
    };
  }
}

app.post("/vapi-webhook", async (req, res) => {
  const payload = req.body;

  try {
    if (!payload || !payload.message) {
      console.log("❗ Ignoring missing payload or message");
      return res.status(200).send("Ignored");
    }

    const status = payload.message?.status?.toLowerCase();
    const finalStatuses = ["end", "ended", "completed"];
    if (!finalStatuses.includes(status)) {
      console.log("⏭️ Not final status, skipping insert");
      return res.status(200).send("Non-final status, no insert");
    }

    const created_at = new Date().toISOString();
    const assistantName =
      payload.message?.assistant?.name ||
      payload.call?.assistant?.name ||
      "Unknown";
    const business_name = assistantName;

    const messages = payload.message?.artifact?.messages || [];

    const raw_transcript = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.message || m.content || ""}`)
      .join("\n");

    const transcriptLength = raw_transcript.length;

    console.log("📜 Raw transcript length:", transcriptLength);
    console.log("🔍 Extracting structured data from transcript...");

    const { caller_name, phone_number, order, quantity } =
      await extractFromTranscript(raw_transcript);

    console.log("✅ Extracted from Groq:");
    console.log("👤 caller_name:", caller_name);
    console.log("📱 phone_number:", phone_number);
    console.log("🧾 order:", order);
    console.log("🔢 quantity:", quantity);

    const dataToInsert = {
      created_at,
      caller_name,
      phone_number,
      order,
      quantity,
      business_name,
      call_length: transcriptLength,
      raw_transcript,
    };

    console.log("📦 Final data to insert:", dataToInsert);

    const { error } = await supabase.from("vapi_call").insert([dataToInsert]);

    if (error) {
      console.error("❌ Supabase insert error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ status: "Data stored successfully" });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/", (req, res) => {
  res.send("Webhook listener is running");
});

app.listen(port, () => {
  console.log(`🚀 Server listening at http://localhost:${port}`);
});

