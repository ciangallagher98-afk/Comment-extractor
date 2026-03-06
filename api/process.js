import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    try {
        const { type, payload } = req.body;
        let messages = [];
        let model = "llama-3.3-70b-versatile"; // Fast text model

        if (type === 'extraction') {
            model = "llama-3.2-90b-vision-preview"; // Vision model for images
            messages = [{ role: "user", content: [
                { type: "text", text: `Extract comments from this image. Return JSON: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }` },
                { type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } }
            ]}];
        } else if (type === 'sentiment') {
            messages = [{ role: "user", content: `Analyze sentiment for these: ${JSON.stringify(payload)}. Return JSON: { "sentiments": [...], "sov": { "Positive": 0, "Negative": 0, "Neutral": 0 } }` }];
        } else {
            messages = [{ role: "user", content: `Summarize these: ${JSON.stringify(payload)}. Return JSON: { "summary": "..." }` }];
        }

        const chat = await groq.chat.completions.create({ messages, model, response_format: { type: "json_object" } });
        res.status(200).json(JSON.parse(chat.choices[0].message.content));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
