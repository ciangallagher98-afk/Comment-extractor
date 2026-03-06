import Groq from "groq-sdk";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { type, payload } = req.body;
        
        // Use the 2026 Production Standard Text Model
        const model = "llama-3.3-70b-versatile"; 

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "user",
                    content: `You are an OCR cleanup assistant. I will provide raw OCR text from a social media comment section. 
                    Clean it up and return a valid JSON object. 
                    Input Text: "${payload}"
                    Format: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`
                }
            ],
            model: model,
            response_format: { type: "json_object" },
            temperature: 0.1, 
        });

        const responseContent = chatCompletion.choices[0]?.message?.content;
        res.status(200).json(JSON.parse(responseContent));

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
