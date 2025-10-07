import { DurableObject } from 'cloudflare:workers';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';

/**
 * Model Options
 */
const MODEL_OPTIONS = {
	openai: ['gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo'],
	gemini: ['gemini-2.0-flash', 'gemini-2.5-pro-exp-03-25'],
	claude: ['claude-3-5-haiku-20241022', 'claude-3-7-sonnet-20250219'],
	groq: ['llama3-8b-8192', 'llama3-70b-8192'],
};

/**
 * Rate Limit Configuration
 */
const RATE_LIMIT = {
	MONTHLY_TOKEN_LIMIT: 500,
	KV_TTL: 30 * 24 * 60 * 60, // 30 days in seconds
	KV_PREFIX: 'rate_limit_ip:',
};

/**
 * Estimate token count from query length
 * This is a simple estimation - actual token count varies by model
 */
function estimateTokenCount(query) {
	// Rough estimation: ~4 characters per token
	return Math.ceil(query.length / 4);
}

/**
 * Durable Object Class
 */
export class MyDurableObject extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
	}

	async sayHello(name) {
		return `Hello, ${name}!`;
	}
}

/**
 * Stream response from Gemini
 */
export async function streamGemini(writer, env, query, model) {
	const textEncoder = new TextEncoder();
	const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
	const modelInstance = genAI.getGenerativeModel({ model });

	try {
		const result = await modelInstance.generateContentStream({ contents: [{ parts: [{ text: query }] }] });

		for await (const chunk of result.stream) {
			if (chunk.usageMetadata.candidatesTokensDetails != undefined) {
				// console.log(chunk.usageMetadata.totalTokenCount)
				writer.write(textEncoder.encode(`data: {"TOKEN_USAGE": ${chunk.usageMetadata.totalTokenCount}}\n\n`));
			} else {
				const text = chunk.text();
				if (text) {
					writer.write(textEncoder.encode(`data: ${text}\n\n`));
				}
			}
		}
	} catch (error) {
		console.error('Gemini Streaming Error:', error);
		writer.write(textEncoder.encode(`Error: ${error.message}\n`));
	} finally {
		writer.close();
	}
}

/**
 * Stream response from OpenAI
 */
export async function streamOpenAI(writer, env, query, model) {
	const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
	const textEncoder = new TextEncoder();

	try {
		const stream = await openai.responses.create({
			model,
			input: [{ role: 'user', content: query }],
			stream: true,
			max_output_tokens: 1024
		});

		for await (const part of stream) {
			if (part.type === "response.completed") {
				// console.log(part.response.usage);
				writer.write(textEncoder.encode(`data: {"TOKEN_USAGE" : ${part.response.usage.total_tokens}}\n\n`));
			} if (part.type === "response.output_text.delta") {
				const content = part.delta
				writer.write(textEncoder.encode(`data: ${content}\n\n`));
			} else {
			}
		}
	} catch (error) {
		handleStreamError(writer, 'OpenAI Streaming Error:', error);
	}
}

/**
 * Stream response from Claude
 */
export async function streamClaude(writer, env, query, model) {
	const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	const textEncoder = new TextEncoder();

	try {
		const stream = await anthropic.messages.stream({
			model,
			max_tokens: 2000,
			messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
			stream: true, // Enable streaming
		});

		// Read streaming response
		for await (const part of stream) {
			if (part.type === 'content_block_delta' && part.delta?.type === 'text_delta') {
				const content = part.delta.text; // Extract text
				writer.write(textEncoder.encode(`data: ${content}\n\n`));
			}
		}
	} catch (error) {
		handleStreamError(writer, 'Claude Streaming Error:', error);
	} finally {
		writer.close();
	}
}

/**
 * Stream response from Groq
 */
export async function streamGroq(writer, env, query, model) {
	const groq = new Groq({ apiKey: env.GROQ_API_KEY });
	const textEncoder = new TextEncoder();

	try {
		const stream = await groq.chat.completions.create({
			model,
			messages: [{ role: 'user', content: query }],
			stream: true,
		});

		for await (const part of stream) {
			if (chat.completion.chunk.x_groq.usage != 0) {
				writer.write(textEncoder.encode(`data: {"TOKEN_USAGE" : ${chat.completion.chunk.x_groq.usage.total_tokens}}\n\n`));
			} else {
				const content = part.choices[0]?.delta?.content || '';
				writer.write(textEncoder.encode(`data: ${content}\n\n`));
			}
		}
	} catch (error) {
		handleStreamError(writer, 'Groq Streaming Error:', error);
	} finally {
		writer.close();
	}
}

/**
 * Handle Streaming Errors
 */
function handleStreamError(writer, message, error) {
	console.error(message, error);
	writer.write(new TextEncoder().encode(`Error: Unable to process request.\n`));
	writer.close();
}

/**
 * Validate POST Request Body
 */
export async function validateRequest(body, env) {
	if (!body || typeof body !== 'object') {
		return { error: 'Invalid request format. Expected JSON.', status: 400 };
	}

	const { provider, model, query, user_id, jwt, visitor_id } = body;

	// Validate visitor
	const USAGE = env.CHATAI_ANONYMOUS_MONTHLY_TOKEN_USAGE;
	const USAGE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

	if (!visitor_id) {
		return { error: `Invalid identity`, status: 400 };
	}

	if (!user_id || !jwt) {
		return { error: `Invalid identity`, status: 400 };
	}

	// chosen_id = chọn user_id hay visitor_id
	const current_usage = await env.CHATAI_ANONYMOUS_MONTHLY_TOKEN_USAGE.get(visitor_id);
	if (!current_usage) {
		await env.CHATAI_ANONYMOUS_MONTHLY_TOKEN_USAGE.put(visitor_id, '1000', { expirationTtl: USAGE_TTL });
	}

	// find usage token from user_id or visitor_id
	// // Authentication check (if required)
	// if (env.REQUIRE_AUTH && jwt !== env.AUTH_TOKEN) {
	// 	return { error: 'Unauthorized: Invalid auth token.', status: 401 };
	// }

	// Validate provider
	if (!provider || !MODEL_OPTIONS[provider]) {
		return { error: `Invalid provider. Available options: ${Object.keys(MODEL_OPTIONS).join(', ')}`, status: 400 };
	}

	// Validate model
	if (!model || !MODEL_OPTIONS[provider].includes(model)) {
		return { error: `Invalid model for provider ${provider}. Available models: ${MODEL_OPTIONS[provider].join(', ')}`, status: 400 };
	}

	// Validate query
	if (!query || typeof query !== 'string' || query.trim() === '') {
		return { error: 'Query cannot be empty.', status: 400 };
	}

	return { provider, model, query, current_usage };
}

/**
 * Handle Streaming requests with POST JSON Body
 */
export async function handleStreaming(request, env, ctx) {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const textEncoder = new TextEncoder();

	try {
		// Parse JSON body
		const body = await request.json();
		const validationResult = await validateRequest(body, env);

		// If validation failed, return error
		if (validationResult.error) {
			return new Response(validationResult.error, { status: validationResult.status });
		}

		const { provider, model, query, current_usage } = validationResult;

		// Start streaming based on provider
		ctx.waitUntil(
			(async () => {
				try {
					if (provider === 'openai') {
						await streamOpenAI(writer, env, query, model);
					} else if (provider === 'gemini') {
						await streamGemini(writer, env, query, model);
					} else if (provider === 'claude') {
						await streamClaude(writer, env, query, model);
					} else if (provider === 'groq') {
						await streamGroq(writer, env, query, model);
					} else {
						writer.write(textEncoder.encode('Error: Unsupported provider.\n'));
					}
				} catch (error) {
					handleStreamError(writer, 'Streaming Error:', error);
				}
				writer.close();
			})()
		);

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	} catch (error) {
		console.error('Request Error:', error);
		return new Response('Invalid JSON body', { status: 400 });
	}
}

/**
 * Main request handler
 */
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === '/stream' && request.method === 'POST') {
			return handleStreaming(request, env, ctx);
		}

		return new Response('Not Found', { status: 404 });
	},
};
