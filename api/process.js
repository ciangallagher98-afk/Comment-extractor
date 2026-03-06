import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Missing API Key' });

    try {
        const { type, payload } = req.body;
        let messages = [];
        
        // 2026 STABLE MODELS
        let textModel = "llama-3.3-70b-specdec"; // Super fast text
        let visionModel = "llama-4-scout-17b-16e-instruct"; // New 2026 Vision model

        if (type === 'extraction') {
            messages = [{
                role: "user",
                content: [
                    { type: "text", text: `Extract comments from this image. Return JSON: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }` },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } }
                ]
            }];
            
            const chat = await groq.chat.completions.create({
                messages: messages,
                model: visionModel, // Using the Llama 4 Scout model here
                response_format: { type: "json_object" },
            });
            return res.status(200).json(JSON.parse(chat.choices[0].message.content));

        } else {
            // Sentiment & Summary logic
            messages = [{ 
                role: "user", 
                content: type === 'sentiment' 
                    ? `Analyze sentiment: ${JSON.stringify(payload)}` 
                    : `Summarize: ${JSON.stringify(payload)}` 
            }];
            
            const chat = await groq.chat.completions.create({
                messages: messages,
                model: textModel,
                response_format: { type: "json_object" },
            });
            return res.status(200).json(JSON.parse(chat.choices[0].message.content));
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
