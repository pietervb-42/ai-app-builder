import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function run() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is missing (check your .env file)');
    return;
  }

  console.log('✅ API key loaded');

  const response = await client.responses.create({
    model: 'gpt-4.1-mini',
    input: 'Say hello and explain what an AI app builder is.',
  });

  console.log('\n🤖 AI RESPONSE:\n');
  console.log(response.output_text);
}

run().catch(console.error);
