import * as Joi from 'joi';

export const validationSchema = Joi.object({
	// Application
	NODE_ENV: Joi.string()
		.valid('development', 'production', 'test')
		.default('development'),
	PORT: Joi.number().default(3031),
	APP_URL: Joi.string().uri().default('http://localhost:3000'),

	// JWT (wallet sign-in)
	JWT_SECRET: Joi.string().min(32).required(),

	// Encryption (for bank account IBANs and other sensitive data at rest)
	ENCRYPTION_KEY: Joi.string().min(32).required(),

	// Database
	DATABASE_URL: Joi.string().required(),

	// Redis
	REDIS_HOST: Joi.string().default('localhost'),
	REDIS_PORT: Joi.number().default(6379),
	REDIS_PASSWORD: Joi.string().allow('').optional(),

	// AI (OpenAI-compatible — defaults to local Ollama)
	OPENAI_API_KEY:  Joi.string().allow('').optional(),
	OPENAI_BASE_URL: Joi.string().uri().optional(),
	OPENAI_MODEL:    Joi.string().optional(),

	// Telegram
	TELEGRAM_BOT_TOKEN: Joi.string().allow('').optional(),
	TELEGRAM_WEBHOOK_DOMAIN: Joi.string().allow('').optional(),
	TELEGRAM_WEBHOOK_PATH: Joi.string().allow('').default('').optional(),

	// Alchemy
	ALCHEMY_API_KEY: Joi.string().allow('').optional(),

	// Wallet
	WALLET_PRIVATE_KEY: Joi.string().allow('').optional(),

	// 1inch
	ONEINCH_API_KEY: Joi.string().allow('').optional(),

	// Kraken — Wrytes AG operator account
	KRAKEN_PUBLIC_KEY: Joi.string().allow('').optional(),
	KRAKEN_PRIVATE_KEY: Joi.string().allow('').optional(),
	KRAKEN_ADDRESS_KEY: Joi.string().allow('').optional(),
	// Withdrawal keys for Wrytes AG's registered bank accounts on Kraken
	KRAKEN_CHF_WITHDRAW_KEY: Joi.string().allow('').optional(),
	KRAKEN_EUR_WITHDRAW_KEY: Joi.string().allow('').optional(),

	// Deribit
	DERIBIT_CLIENT_ID: Joi.string().allow('').optional(),
	DERIBIT_CLIENT_SECRET: Joi.string().allow('').optional(),
	DERIBIT_BASE_URL: Joi.string().allow('').optional(),

	// Logging
	LOG_LEVEL: Joi.string()
		.valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
		.default('info'),
	LOG_PRETTY: Joi.boolean().default(false),

	// Rate Limiting
	THROTTLE_TTL: Joi.number().default(60),
	THROTTLE_LIMIT: Joi.number().default(100),

	// Off-ramp monitor
	MONITOR_MODE: Joi.string().valid('polling', 'webhook').default('polling'),
	MONITOR_POLL_INTERVAL_MS: Joi.number().default(60000),
	ALCHEMY_WEBHOOK_SECRET: Joi.string().allow('').optional(),
});
